import { RetryManager } from './retry';
import { SyncManager } from './sync';
import { calculateChunkPriority, getChunkWindow } from './priority';
import { selectBestHolder } from './holder-selection';
import { ChunkIndex } from './types';
import { PeerId, PlaybackState } from '../../protocol/control';
import {
  CancelChunkCommand,
  RequestChunkCommand,
  SchedulerCommand,
  SchedulerCommands,
} from './types';

export interface ChunkSchedulerOptions {
  chunkDurationSec: number;
  totalChunks: number;
}

/**
 * The top-level scheduling engine for a single viewer peer.
 *
 * Pure logic only: no sockets, no WebRTC, no MSE/SourceBuffer access.
 * It consumes tracker-provided facts (PlaybackState, eligible holder
 * lists from getEligibleChunkHolders()/CHUNK_QUERY_RES) and emits
 * SchedulerCommand objects for the host app to actually execute over
 * packages/webrtc using the existing data-codec.
 */
export class ChunkScheduler {
  private readonly sync: SyncManager;
  private readonly retry: RetryManager;
  private readonly chunkDurationSec: number;
  private readonly totalChunks: number;

  /** chunkIndex -> most recent list of eligible holders from the tracker. */
  private eligibleHolders = new Map<ChunkIndex, PeerId[]>();

  private currentEpoch = 0;

  constructor(
    options: ChunkSchedulerOptions,
    sync: SyncManager = new SyncManager(),
    retry: RetryManager = new RetryManager()
  ) {
    this.chunkDurationSec = options.chunkDurationSec;
    this.totalChunks = options.totalChunks;
    this.sync = sync;
    this.retry = retry;
  }

  getSyncManager(): SyncManager {
    return this.sync;
  }

  getRetryManager(): RetryManager {
    return this.retry;
  }

  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  /**
   * Feeds a fresh PlaybackState (from PLAYBACK_STATE_RES/EVENT) into the
   * scheduler. If it's a newer revision, bumps the local epoch — but does
   * NOT purge in-flight requests itself. Call `purgeForNewEpoch()`
   * immediately after this (see below) to get back the list of cancelled
   * requests and actually tear them down over the transport.
   *
   * Returns true if the update was accepted (i.e. wasn't stale), false
   * if it was dropped because a newer revision was already known.
   */
  updatePlaybackState(state: PlaybackState): boolean {
    const wasAccepted = this.sync.applyPlaybackState(state);
    if (!wasAccepted) return false;

    // Any accepted revision bump is treated as a potential seek — bump
    // the epoch so `purgeForNewEpoch()` can drop stale in-flight work.
    this.currentEpoch += 1;
    return true;
  }

  /** Records the tracker's answer to a CHUNK_QUERY_REQ for a given chunk. */
  updateEligibleHolders(chunkIndex: ChunkIndex, holderIds: PeerId[]): void {
    this.eligibleHolders.set(chunkIndex, holderIds);
  }

  /** Call when a PAYLOAD packet is fully received and validated. */
  onChunkReceived(requestId: string, now: number = Date.now()): void {
    this.retry.recordSuccess(requestId, now);
  }

  /** Call when a peer responds with NOT_AVAILABLE for a given request. */
  onChunkUnavailable(requestId: string, now: number = Date.now()): void {
    this.retry.recordFailure(requestId, 'NOT_AVAILABLE', now);
  }

  /**
   * The main scheduling loop. Call roughly every ~100ms, or whenever
   * playback state / holder info changes.
   *
   * @param localNow          current local clock time (ms)
   * @param localMediaTimeMs  current position of the local <video> element (ms)
   * @param ownedChunks       chunk indices already downloaded/cached locally
   */
  tick(
    localNow: number,
    localMediaTimeMs: number,
    ownedChunks: Set<ChunkIndex>
  ): SchedulerCommands {
    const commands: SchedulerCommand[] = [];

    // 1. Timeouts first, so freed-up peer capacity is usable this same tick.
    this.retry.checkTimeouts(localNow);

    // 2. Where should we actually be right now?
    const drift = this.sync.evaluate(localMediaTimeMs, localNow) ?? { type: 'NONE' as const };

    const currentState = this.sync.getCurrentState();
    const targetMediaTimeMs =
      drift.type === 'HARD_SEEK'
        ? drift.targetMediaTimeMs
        : currentState
          ? localMediaTimeMs
          : localMediaTimeMs;

    // 3. Figure out which chunks we need next.
    const targetSec = targetMediaTimeMs / 1000;
    const { urgent, prefetch } = getChunkWindow(targetSec, this.chunkDurationSec, this.totalChunks);
    const playheadChunk = Math.floor(targetSec / this.chunkDurationSec);

    const candidates = [...urgent, ...prefetch].filter((idx) => !ownedChunks.has(idx));

    for (const chunkIndex of candidates) {
      if (this.retry.isBlacklisted(chunkIndex, localNow)) continue;
      if (this.retry.hasInFlightRequest(chunkIndex)) continue;

      const { tier } = calculateChunkPriority(chunkIndex, playheadChunk);
      if (tier === 'IGNORED') continue;

      const holders = this.eligibleHolders.get(chunkIndex) ?? [];
      if (holders.length === 0) continue;

      const peerId = selectBestHolder(holders, this.retry.getPeerStats());
      if (!peerId) continue; // every eligible holder is at capacity right now

      const isUrgent = tier === 'URGENT';
      const record = this.retry.startRequest(
        chunkIndex,
        peerId,
        this.currentEpoch,
        isUrgent,
        localNow
      );

      const cmd: RequestChunkCommand = {
        type: 'REQUEST_CHUNK',
        chunkIndex,
        peerId,
        requestId: record.requestId,
        epoch: this.currentEpoch,
      };
      commands.push(cmd);
    }

    return { commands, drift };
  }

  /**
   * Emits explicit cancel commands for whatever the retry manager just
   * purged due to an epoch bump (call right after updatePlaybackState on
   * a seek, so the transport layer can tear down in-flight requests).
   */
  purgeForNewEpoch(): CancelChunkCommand[] {
    const purged = this.retry.purgeStaleEpoch(this.currentEpoch);
    return purged.map((r) => ({
      type: 'CANCEL_CHUNK' as const,
      chunkIndex: r.chunkIndex,
      peerId: r.peerId,
      requestId: r.requestId,
    }));
  }
}
