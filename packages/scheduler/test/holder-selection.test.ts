import { describe, it, expect } from 'vitest';
import { selectBestHolder, MAX_CONCURRENT_REQUESTS_PER_PEER } from '../src/holder-selection';
import { PeerPerformance } from '../src/types';

function stats(overrides: Partial<PeerPerformance> & { peerId: string }): PeerPerformance {
  return { pendingRequests: 0, latencyEmaMs: 0, recentFailures: 0, ...overrides };
}

describe('selectBestHolder', () => {
  it('returns null when the holder list is empty', () => {
    expect(selectBestHolder([], new Map())).toBeNull();
  });

  it('picks an unknown (no-history) peer over a busy known peer', () => {
    const peerStats = new Map([
      ['peerA', stats({ peerId: 'peerA', pendingRequests: 2, latencyEmaMs: 50 })],
    ]);
    const best = selectBestHolder(['peerA', 'peerB'], peerStats);
    expect(best).toBe('peerB');
  });

  it('prefers the peer with fewer pending requests', () => {
    const peerStats = new Map([
      ['peerA', stats({ peerId: 'peerA', pendingRequests: 0, latencyEmaMs: 200 })],
      ['peerB', stats({ peerId: 'peerB', pendingRequests: 3, latencyEmaMs: 10 })],
    ]);
    const best = selectBestHolder(['peerA', 'peerB'], peerStats);
    expect(best).toBe('peerA');
  });

  it('excludes peers at or above the max concurrent request limit', () => {
    const peerStats = new Map([
      ['peerA', stats({ peerId: 'peerA', pendingRequests: MAX_CONCURRENT_REQUESTS_PER_PEER })],
      ['peerB', stats({ peerId: 'peerB', pendingRequests: 1 })],
    ]);
    const best = selectBestHolder(['peerA', 'peerB'], peerStats);
    expect(best).toBe('peerB');
  });

  it('returns null when every eligible holder is at capacity', () => {
    const peerStats = new Map([
      ['peerA', stats({ peerId: 'peerA', pendingRequests: MAX_CONCURRENT_REQUESTS_PER_PEER })],
    ]);
    expect(selectBestHolder(['peerA'], peerStats)).toBeNull();
  });

  it('penalizes peers with recent failures heavily', () => {
    const peerStats = new Map([
      ['peerA', stats({ peerId: 'peerA', latencyEmaMs: 500, recentFailures: 0 })],
      ['peerB', stats({ peerId: 'peerB', latencyEmaMs: 10, recentFailures: 5 })],
    ]);
    const best = selectBestHolder(['peerA', 'peerB'], peerStats);
    expect(best).toBe('peerA');
  });
});
