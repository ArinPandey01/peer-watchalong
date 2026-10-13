import {
  ChunkRequestScheduler,
  DEFAULT_PREFETCH_WINDOW_SEC,
  type ChunkRequestAction,
  type PlannedChunk,
} from '@peer-watchalong/scheduler';
import {
  DataOpcode,
  type ChunkNotAvailable,
  type ChunkPayload,
  type MediaManifest,
} from '@peer-watchalong/protocol';
import { sha256Hex } from './chunk-hash.ts';

export interface ViewerChunkOptions {
  manifest: MediaManifest;
  queryHolders: (chunkIndex: number) => Promise<readonly string[]>;
  requestChunk: (peerId: string, chunkIndex: number, requestId: number) => Promise<void>;
  announceChunk: (chunkIndex: number) => void;
  onProgress?: (downloaded: number, total: number) => void;
  onChunk?: (chunkIndex: number, data: Uint8Array) => void;
  onError?: (error: Error) => void;
  now?: () => number;
}

export class ViewerChunkLoader {
  private readonly options: ViewerChunkOptions;
  private readonly scheduler = new ChunkRequestScheduler();
  private readonly owned = new Map<number, Uint8Array>();
  private readonly now: () => number;
  private closed = false;

  constructor(options: ViewerChunkOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.options.onProgress?.(0, options.manifest.chunks.length);
  }

  readChunk(chunkIndex: number): Uint8Array | null {
    return this.owned.get(chunkIndex) ?? null;
  }

  updateTarget(targetTimeSec: number, revision: number): void {
    if (this.closed) return;
    const plan = this.plan(targetTimeSec);
    this.dispatch(this.scheduler.updatePlan(plan, revision, this.now()));
  }

  tick(): void {
    if (!this.closed) this.dispatch(this.scheduler.tick(this.now()));
  }

  async receive(peerId: string, result: ChunkPayload | ChunkNotAvailable): Promise<void> {
    if (this.closed) return;
    let valid = false;
    if (result.opcode === DataOpcode.PAYLOAD) {
      const expected = this.options.manifest.chunks[result.chunkIndex];
      if (expected && result.data.byteLength === expected.byteLength) {
        try {
          valid = await sha256Hex(result.data) === expected.sha256;
        } catch (error) {
          this.reportError(error);
        }
      }
    }
    if (this.closed) return;
    this.dispatch(this.scheduler.onData(peerId, result, this.now(), valid));
  }

  close(): void {
    this.closed = true;
    this.owned.clear();
  }

  private plan(targetTimeSec: number): PlannedChunk[] {
    const target = Math.max(0, Math.min(targetTimeSec, this.options.manifest.durationSec));
    const plan: PlannedChunk[] = [];
    for (const chunk of this.options.manifest.chunks) {
      if (this.owned.has(chunk.chunkIndex)) continue;
      if (chunk.kind === 'init') {
        plan.push({ chunkIndex: chunk.chunkIndex, priority: 'URGENT', secondsUntilNeeded: 0 });
      } else if (chunk.endTimeSec > target &&
          chunk.startTimeSec <= target + DEFAULT_PREFETCH_WINDOW_SEC) {
        const secondsUntilNeeded = Math.max(0, chunk.startTimeSec - target);
        plan.push({ chunkIndex: chunk.chunkIndex,
          priority: secondsUntilNeeded <= 3 ? 'URGENT' : 'PREFETCH',
          secondsUntilNeeded });
      }
    }
    return plan.sort((a, b) => a.secondsUntilNeeded - b.secondsUntilNeeded ||
      a.chunkIndex - b.chunkIndex);
  }

  private dispatch(actions: readonly ChunkRequestAction[]): void {
    for (const action of actions) {
      if (this.closed) return;
      switch (action.type) {
        case 'QUERY_HOLDERS':
          void this.options.queryHolders(action.chunkIndex).then((holderIds) => {
            if (this.closed) return;
            this.dispatch(this.scheduler.onHolders(
              action.chunkIndex, action.queryToken, holderIds, this.now(),
            ));
          }).catch((error: unknown) => this.reportError(error));
          break;
        case 'REQUEST_CHUNK':
          void this.options.requestChunk(action.peerId, action.chunkIndex, action.requestId)
            .catch((error: unknown) => {
              if (this.closed) return;
              this.reportError(error);
              this.dispatch(this.scheduler.onRequestSendFailed(
                action.peerId, action.chunkIndex, action.requestId, this.now(),
              ));
            });
          break;
        case 'CHUNK_RECEIVED':
          this.owned.set(action.chunkIndex, action.data);
          this.options.onChunk?.(action.chunkIndex, action.data);
          this.options.onProgress?.(this.owned.size, this.options.manifest.chunks.length);
          try {
            this.options.announceChunk(action.chunkIndex);
          } catch (error) {
            this.reportError(error);
          }
          break;
      }
    }
  }

  private reportError(error: unknown): void {
    if (!this.closed) this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
