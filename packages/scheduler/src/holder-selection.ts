import type { PeerId } from '../../protocol/control.ts';

export interface PeerPerformance {
  // Initial metrics. Will change on later version.
  pendingRequests: number;
  recentFailures?: number;
  latencyEmaMs?: number;
}

export interface HolderSelectionOptions {
  maxConcurrentRequestsPerPeer?: number;
  excludePeerIds?: ReadonlySet<PeerId>;
}

export const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_PEER = 3;


export function rankEligibleHolders(
  holderIds: readonly PeerId[],
  performance: ReadonlyMap<PeerId, PeerPerformance>,
  options: HolderSelectionOptions = {},
): PeerId[] {
  const maxConcurrentRequestsPerPeer = options.maxConcurrentRequestsPerPeer ??
    DEFAULT_MAX_CONCURRENT_REQUESTS_PER_PEER;
  if (!Number.isSafeInteger(maxConcurrentRequestsPerPeer) ||
      maxConcurrentRequestsPerPeer <= 0) {
    throw new RangeError('maxConcurrentRequestsPerPeer must be a positive integer');
  }

  const eligible = [...new Set(holderIds)]
    .filter((peerId) => !options.excludePeerIds?.has(peerId))
    .filter((peerId) => {
      const stats = performance.get(peerId);
      if (stats) validatePerformance(stats);
      return (stats?.pendingRequests ?? 0) < maxConcurrentRequestsPerPeer;
    });

  return eligible.sort((left, right) => {
    const a = performance.get(left);
    const b = performance.get(right);

    return compare(a?.pendingRequests ?? 0, b?.pendingRequests ?? 0) ||
      compare(a?.recentFailures ?? 0, b?.recentFailures ?? 0) ||
      compare(a?.latencyEmaMs ?? 0, b?.latencyEmaMs ?? 0) ||
      (left < right ? -1 : left > right ? 1 : 0);
  });
}

function compare(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePerformance(stats: PeerPerformance): void {
  if (!Number.isSafeInteger(stats.pendingRequests) || stats.pendingRequests < 0 ||
      !Number.isSafeInteger(stats.recentFailures ?? 0) ||
      (stats.recentFailures ?? 0) < 0 ||
      !Number.isFinite(stats.latencyEmaMs ?? 0) ||
      (stats.latencyEmaMs ?? 0) < 0) {
    throw new RangeError('peer performance must contain non-negative counts and latency');
  }
}
