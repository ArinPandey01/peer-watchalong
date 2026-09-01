import { ChunkIndex } from './types';
import { PeerId } from '../../protocol/control';
import { ExpiredRequest, InFlightRequest, PeerPerformance } from './types';

export const URGENT_TIMEOUT_MS = 600;
export const PREFETCH_TIMEOUT_MS = 1500;
export const MAX_RETRIES_PER_CHUNK = 3;
export const CHUNK_BLACKLIST_MS = 2000;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now()}_${requestCounter}`;
}

/**
 * Tracks in-flight chunk requests, surfaces timeouts, and maintains
 * per-peer reliability stats used by holder-selection. Owns nothing about
 * topology or transport — purely bookkeeping + policy.
 */
export class RetryManager {
  private inFlight = new Map<string, InFlightRequest>(); // requestId -> request
  private retryCounts = new Map<ChunkIndex, number>();
  private blacklistedUntil = new Map<ChunkIndex, number>();
  private peerStats = new Map<PeerId, PeerPerformance>();

  private getOrCreatePeerStats(peerId: PeerId): PeerPerformance {
    let stats = this.peerStats.get(peerId);
    if (!stats) {
      stats = { peerId, pendingRequests: 0, latencyEmaMs: 0, recentFailures: 0 };
      this.peerStats.set(peerId, stats);
    }
    return stats;
  }

  getPeerStats(): Map<PeerId, PeerPerformance> {
    return this.peerStats;
  }

  isBlacklisted(chunkIndex: ChunkIndex, now: number): boolean {
    const until = this.blacklistedUntil.get(chunkIndex);
    return until !== undefined && now < until;
  }

  getRetryCount(chunkIndex: ChunkIndex): number {
    return this.retryCounts.get(chunkIndex) ?? 0;
  }

  /** Registers a new outbound request and returns the bookkeeping record. */
  startRequest(
    chunkIndex: ChunkIndex,
    peerId: PeerId,
    epoch: number,
    isUrgent: boolean,
    now: number
  ): InFlightRequest {
    const requestId = nextRequestId();
    const timeoutMs = isUrgent ? URGENT_TIMEOUT_MS : PREFETCH_TIMEOUT_MS;
    const retryCount = this.getRetryCount(chunkIndex);

    const record: InFlightRequest = {
      chunkIndex,
      peerId,
      requestId,
      sentAt: now,
      timeoutMs,
      retryCount,
      epoch,
    };

    this.inFlight.set(requestId, record);
    this.getOrCreatePeerStats(peerId).pendingRequests += 1;

    return record;
  }

  /** Call when a PAYLOAD arrives successfully for a request. */
  recordSuccess(requestId: string, now: number): void {
    const record = this.inFlight.get(requestId);
    if (!record) return;

    this.inFlight.delete(requestId);
    this.retryCounts.delete(record.chunkIndex);

    const stats = this.getOrCreatePeerStats(record.peerId);
    stats.pendingRequests = Math.max(0, stats.pendingRequests - 1);

    const sampleLatency = now - record.sentAt;
    stats.latencyEmaMs =
      stats.latencyEmaMs === 0 ? sampleLatency : stats.latencyEmaMs * 0.7 + sampleLatency * 0.3;
  }

  /** Call on an explicit NOT_AVAILABLE response or a detected timeout. */
  recordFailure(
    requestId: string,
    reason: 'TIMEOUT' | 'NOT_AVAILABLE',
    now: number
  ): void {
    const record = this.inFlight.get(requestId);
    if (!record) return;

    this.inFlight.delete(requestId);

    const stats = this.getOrCreatePeerStats(record.peerId);
    stats.pendingRequests = Math.max(0, stats.pendingRequests - 1);
    stats.recentFailures += 1;
    stats.lastFailureAt = now;

    const retries = this.getRetryCount(record.chunkIndex) + 1;
    this.retryCounts.set(record.chunkIndex, retries);

    if (retries >= MAX_RETRIES_PER_CHUNK) {
      this.blacklistedUntil.set(record.chunkIndex, now + CHUNK_BLACKLIST_MS);
      this.retryCounts.delete(record.chunkIndex);
    }

    void reason; // reason currently only affects logging/telemetry hooks
  }

  /** Scans in-flight requests and returns (and removes) any that exceeded their deadline. */
  checkTimeouts(now: number): ExpiredRequest[] {
    const expired: ExpiredRequest[] = [];

    for (const [requestId, record] of this.inFlight.entries()) {
      if (now - record.sentAt >= record.timeoutMs) {
        expired.push({
          chunkIndex: record.chunkIndex,
          peerId: record.peerId,
          requestId,
          retryCount: record.retryCount,
        });
        this.recordFailure(requestId, 'TIMEOUT', now);
      }
    }

    return expired;
  }

  /** Cancels every in-flight request tagged with an epoch older than `currentEpoch`. */
  purgeStaleEpoch(currentEpoch: number): InFlightRequest[] {
    const purged: InFlightRequest[] = [];
    for (const [requestId, record] of this.inFlight.entries()) {
      if (record.epoch < currentEpoch) {
        purged.push(record);
        this.inFlight.delete(requestId);
        const stats = this.getOrCreatePeerStats(record.peerId);
        stats.pendingRequests = Math.max(0, stats.pendingRequests - 1);
      }
    }
    return purged;
  }

  hasInFlightRequest(chunkIndex: ChunkIndex): boolean {
    for (const record of this.inFlight.values()) {
      if (record.chunkIndex === chunkIndex) return true;
    }
    return false;
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }
}
