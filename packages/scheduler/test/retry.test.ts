import { describe, it, expect } from 'vitest';
import { RetryManager, URGENT_TIMEOUT_MS, PREFETCH_TIMEOUT_MS, MAX_RETRIES_PER_CHUNK } from '../src/retry';

describe('RetryManager', () => {
  it('assigns a shorter timeout for urgent requests than prefetch requests', () => {
    const retry = new RetryManager();
    const urgentReq = retry.startRequest(1, 'peerA', 0, true, 0);
    const prefetchReq = retry.startRequest(2, 'peerA', 0, false, 0);
    expect(urgentReq.timeoutMs).toBe(URGENT_TIMEOUT_MS);
    expect(prefetchReq.timeoutMs).toBe(PREFETCH_TIMEOUT_MS);
  });

  it('detects a timed-out request via checkTimeouts', () => {
    const retry = new RetryManager();
    const req = retry.startRequest(1, 'peerA', 0, true, 0);
    const expired = retry.checkTimeouts(req.sentAt + URGENT_TIMEOUT_MS + 1);
    expect(expired).toHaveLength(1);
    expect(expired[0].chunkIndex).toBe(1);
    expect(expired[0].peerId).toBe('peerA');
  });

  it('does not report requests still within their deadline', () => {
    const retry = new RetryManager();
    const req = retry.startRequest(1, 'peerA', 0, true, 0);
    const expired = retry.checkTimeouts(req.sentAt + URGENT_TIMEOUT_MS - 1);
    expect(expired).toHaveLength(0);
  });

  it('blacklists a chunk after MAX_RETRIES_PER_CHUNK consecutive failures', () => {
    const retry = new RetryManager();
    let now = 0;
    for (let i = 0; i < MAX_RETRIES_PER_CHUNK; i++) {
      const req = retry.startRequest(7, 'peerA', 0, true, now);
      retry.recordFailure(req.requestId, 'TIMEOUT', now + 1);
      now += 10;
    }
    expect(retry.isBlacklisted(7, now)).toBe(true);
  });

  it('tracks pending request count per peer and decrements on success/failure', () => {
    const retry = new RetryManager();
    const req = retry.startRequest(1, 'peerA', 0, true, 0);
    expect(retry.getPeerStats().get('peerA')?.pendingRequests).toBe(1);

    retry.recordSuccess(req.requestId, 100);
    expect(retry.getPeerStats().get('peerA')?.pendingRequests).toBe(0);
  });

  it('updates latency EMA on successful responses', () => {
    const retry = new RetryManager();
    const req = retry.startRequest(1, 'peerA', 0, true, 0);
    retry.recordSuccess(req.requestId, 100); // 100ms latency
    expect(retry.getPeerStats().get('peerA')?.latencyEmaMs).toBe(100);
  });

  it('purges in-flight requests tagged with a stale epoch', () => {
    const retry = new RetryManager();
    retry.startRequest(1, 'peerA', 0, true, 0); // epoch 0
    retry.startRequest(2, 'peerA', 1, true, 0); // epoch 1

    const purged = retry.purgeStaleEpoch(1); // anything < 1 is stale
    expect(purged).toHaveLength(1);
    expect(purged[0].chunkIndex).toBe(1);
    expect(retry.hasInFlightRequest(2)).toBe(true);
    expect(retry.hasInFlightRequest(1)).toBe(false);
  });
});
