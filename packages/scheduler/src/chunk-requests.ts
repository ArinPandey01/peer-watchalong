import type { PeerId } from '../../protocol/control.ts';
import type { ChunkNotAvailable, ChunkPayload } from '../../protocol/data.ts';
import { rankEligibleHolders, type PeerPerformance } from './holder-selection.ts';
import type { PlannedChunk } from './chunk-planning.ts';

export type ChunkRequestAction =
  | { type: 'QUERY_HOLDERS'; chunkIndex: number; queryToken: number }
  | { type: 'REQUEST_CHUNK'; peerId: PeerId; chunkIndex: number; requestId: number }
  | { type: 'CHUNK_RECEIVED'; peerId: PeerId; chunkIndex: number; data: Uint8Array };

export interface ChunkRequestOptions {
  requestTimeoutMs?: number;
  queryTimeoutMs?: number;
  initialQueryBackoffMs?: number;
  maxQueryBackoffMs?: number;
  maxConcurrentRequests?: number;
  maxConcurrentQueries?: number;
  maxConcurrentRequestsPerPeer?: number;
}

interface PendingQuery { token: number; sentAtMs: number }
interface PendingRequest {
  requestId: number;
  peerId: PeerId;
  sentAtMs: number;
  lastActivityAtMs: number;
}
interface ChunkWork {
  chunkIndex: number;
  holderIds: readonly PeerId[] | null;
  tried: Set<PeerId>;
  query: PendingQuery | null;
  request: PendingRequest | null;
  nextQueryAtMs: number;
  queryFailures: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 3000;
export const DEFAULT_INITIAL_QUERY_BACKOFF_MS = 500;
export const DEFAULT_MAX_QUERY_BACKOFF_MS = 8000;

export class ChunkRequestScheduler {
  private readonly work = new Map<number, ChunkWork>();
  private readonly completed = new Set<number>();
  private readonly performance = new Map<PeerId, PeerPerformance>();
  private readonly options: Required<ChunkRequestOptions>;
  private revision: number | null = null;
  private nextQueryToken = 1;
  private nextRequestId = 1;

  constructor(options: ChunkRequestOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      initialQueryBackoffMs: options.initialQueryBackoffMs ?? DEFAULT_INITIAL_QUERY_BACKOFF_MS,
      maxQueryBackoffMs: options.maxQueryBackoffMs ?? DEFAULT_MAX_QUERY_BACKOFF_MS,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 6,
      maxConcurrentQueries: options.maxConcurrentQueries ?? 4,
      maxConcurrentRequestsPerPeer: options.maxConcurrentRequestsPerPeer ?? 3,
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if (this.options.initialQueryBackoffMs > this.options.maxQueryBackoffMs) {
      throw new RangeError('initialQueryBackoffMs must not exceed maxQueryBackoffMs');
    }
  }
  updatePlan(plan: readonly PlannedChunk[], revision: number, nowMs: number): ChunkRequestAction[] {
    assertUint32(revision, 'revision');
    assertTime(nowMs);
    if (this.revision !== null && revision < this.revision) return [];
    const indices = new Set<number>();
    for (const item of plan) {
      assertUint32(item.chunkIndex, 'chunkIndex');
      if (indices.has(item.chunkIndex)) throw new RangeError('plan contains a duplicate chunkIndex');
      indices.add(item.chunkIndex);
    }
    if (this.revision !== revision) {
      this.clearWork();
      this.completed.clear();
      this.revision = revision;
    }
    for (const [chunkIndex, item] of this.work) {
      if (!indices.has(chunkIndex)) this.drop(item);
    }
    const ordered = new Map<number, ChunkWork>();
    for (const { chunkIndex } of plan) {
      if (!this.completed.has(chunkIndex) && !this.work.has(chunkIndex)) {
        this.work.set(chunkIndex, {
          chunkIndex, holderIds: null, tried: new Set(), query: null,
          request: null, nextQueryAtMs: nowMs, queryFailures: 0,
        });
      }
      const item = this.work.get(chunkIndex);
      if (item) ordered.set(chunkIndex, item);
    }
    this.work.clear();
    for (const [chunkIndex, item] of ordered) this.work.set(chunkIndex, item);
    return this.pump(nowMs);
  }

  onHolders(chunkIndex: number, queryToken: number, holderIds: readonly PeerId[], nowMs: number): ChunkRequestAction[] {
    assertTime(nowMs);
    const item = this.work.get(chunkIndex);
    if (!item || item.query?.token !== queryToken) return [];
    item.query = null;
    item.holderIds = [...new Set(holderIds)];
    item.tried.clear();
    if (item.holderIds.length === 0) {
      item.holderIds = null;
      this.deferQuery(item, nowMs);
    } else {
      item.queryFailures = 0;
    }
    return this.pump(nowMs);
  }

  onRequestSendFailed(peerId: PeerId, chunkIndex: number, requestId: number, nowMs: number): ChunkRequestAction[] {
    assertTime(nowMs);
    const item = this.work.get(chunkIndex);
    if (!item?.request || item.request.peerId !== peerId ||
        item.request.requestId !== requestId) return [];
    this.failRequest(item);
    item.tried.add(peerId);
    return this.pump(nowMs);
  }

  onData(
    peerId: PeerId,
    message: ChunkPayload | ChunkNotAvailable,
    nowMs: number,
    validPayload = false,
  ): ChunkRequestAction[] {
    assertTime(nowMs);
    const item = this.work.get(message.chunkIndex);
    const pending = item?.request;
    if (!item || !pending || pending.peerId !== peerId ||
        pending.requestId !== message.requestId) return [];

    if (message.opcode === 0x02 && validPayload) {
      this.finishRequest(item, nowMs, message.data.byteLength);
      this.work.delete(item.chunkIndex);
      return [{ type: 'CHUNK_RECEIVED', peerId, chunkIndex: item.chunkIndex, data: message.data },
        ...this.pump(nowMs)];
    }
    this.failRequest(item);
    item.tried.add(peerId);
    return this.pump(nowMs);
  }

  onRequestProgress(peerId: PeerId, chunkIndex: number, requestId: number, nowMs: number): void {
    assertTime(nowMs);
    const pending = this.work.get(chunkIndex)?.request;
    if (pending?.peerId === peerId && pending.requestId === requestId) {
      pending.lastActivityAtMs = nowMs;
    }
  }

  markOwned(chunkIndex: number, nowMs: number): ChunkRequestAction[] {
    assertUint32(chunkIndex, 'chunkIndex');
    assertTime(nowMs);
    const item = this.work.get(chunkIndex);
    if (item) this.drop(item);
    this.completed.add(chunkIndex);
    return this.pump(nowMs);
  }

  tick(nowMs: number): ChunkRequestAction[] {
    assertTime(nowMs);
    for (const item of this.work.values()) {
      if (item.request && nowMs - item.request.lastActivityAtMs >= this.options.requestTimeoutMs) {
        item.tried.add(item.request.peerId);
        this.failRequest(item);
      }
      if (item.query && nowMs - item.query.sentAtMs >= this.options.queryTimeoutMs) {
        item.query = null;
        item.holderIds = null;
        this.deferQuery(item, nowMs);
      }
    }
    return this.pump(nowMs);
  }

  getPeerPerformance(): ReadonlyMap<PeerId, PeerPerformance> {
    return new Map([...this.performance].map(([peerId, stats]) => [peerId, { ...stats }]));
  }

  private pump(nowMs: number): ChunkRequestAction[] {
    const actions: ChunkRequestAction[] = [];
    let requests = [...this.work.values()].filter((item) => item.request).length;
    let queries = [...this.work.values()].filter((item) => item.query).length;
    for (const item of this.work.values()) {
      if (item.request || item.query) continue;
      if (item.holderIds !== null) {
        const ranked = rankEligibleHolders(item.holderIds, this.performance, {
          excludePeerIds: item.tried,
          maxConcurrentRequestsPerPeer: this.options.maxConcurrentRequestsPerPeer,
        });
        if (ranked.length && requests < this.options.maxConcurrentRequests) {
          const peerId = ranked[0]!;
          const requestId = this.allocateRequestId();
          item.request = { peerId, requestId, sentAtMs: nowMs, lastActivityAtMs: nowMs };
          this.stats(peerId).pendingRequests++;
          requests++;
          actions.push({ type: 'REQUEST_CHUNK', peerId, chunkIndex: item.chunkIndex, requestId });
          continue;
        }
        if (item.holderIds.some((peerId) => !item.tried.has(peerId))) continue;
        item.holderIds = null;
        this.deferQuery(item, nowMs);
      }
      if (nowMs >= item.nextQueryAtMs && queries < this.options.maxConcurrentQueries) {
        const queryToken = this.nextQueryToken++;
        item.query = { token: queryToken, sentAtMs: nowMs };
        queries++;
        actions.push({ type: 'QUERY_HOLDERS', chunkIndex: item.chunkIndex, queryToken });
      }
    }
    return actions;
  }

  private deferQuery(item: ChunkWork, nowMs: number): void {
    const delay = Math.min(
      this.options.maxQueryBackoffMs,
      this.options.initialQueryBackoffMs * 2 ** Math.min(item.queryFailures, 30),
    );
    item.queryFailures++;
    item.nextQueryAtMs = nowMs + delay;
  }

  private finishRequest(item: ChunkWork, nowMs: number, byteLength: number): void {
    const pending = item.request!;
    const stats = this.stats(pending.peerId);
    stats.pendingRequests--;
    const durationMs = Math.max(1, nowMs - pending.sentAtMs);
    stats.latencyEmaMs = ema(stats.latencyEmaMs, durationMs);
    stats.throughputEmaBytesPerSec = ema(
      stats.throughputEmaBytesPerSec, byteLength * 1000 / durationMs,
    );
    stats.recentFailures = Math.max(0, (stats.recentFailures ?? 0) - 1);
    item.request = null;
  }

  private failRequest(item: ChunkWork): void {
    const pending = item.request!;
    const stats = this.stats(pending.peerId);
    stats.pendingRequests--;
    stats.recentFailures = Math.min(100, (stats.recentFailures ?? 0) + 1);
    item.request = null;
  }

  private stats(peerId: PeerId): PeerPerformance {
    let stats = this.performance.get(peerId);
    if (!stats) {
      stats = { pendingRequests: 0 };
      this.performance.set(peerId, stats);
    }
    return stats;
  }

  private drop(item: ChunkWork): void {
    if (item.request) this.stats(item.request.peerId).pendingRequests--;
    this.work.delete(item.chunkIndex);
  }

  private clearWork(): void {
    for (const item of this.work.values()) this.drop(item);
  }

  private allocateRequestId(): number {
    if (this.nextRequestId > 0xffff_ffff) {
      throw new RangeError('request ID space exhausted');
    }
    return this.nextRequestId++;
  }
}

function ema(previous: number | undefined, sample: number): number {
  return previous === undefined ? sample : previous * 0.75 + sample * 0.25;
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a uint32`);
  }
}

function assertTime(nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('nowMs must be non-negative and finite');
  }
}
