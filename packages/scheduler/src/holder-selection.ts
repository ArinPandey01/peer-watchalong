import { PeerId } from '../../protocol/control';
import { PeerPerformance } from './types';

export const MAX_CONCURRENT_REQUESTS_PER_PEER = 3;

const WEIGHT_PENDING = 100; // heavily penalize already-busy peers
const WEIGHT_LATENCY = 1;
const WEIGHT_FAILURES = 250; // failures hurt more than latency or queue depth

/**
 * Picks the best peer to request a chunk from among `eligibleHolders`
 * (the list returned by the tracker's getEligibleChunkHolders() /
 * CHUNK_QUERY_RES — the scheduler never computes eligibility itself).
 *
 * Lower score wins. Returns null if no eligible peer currently has
 * capacity for another request.
 */
export function selectBestHolder(
  eligibleHolders: PeerId[],
  peerStats: Map<PeerId, PeerPerformance>
): PeerId | null {
  let best: PeerId | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const peerId of eligibleHolders) {
    const stats = peerStats.get(peerId);

    // Unknown peer = no history yet = treat as a clean, available candidate.
    if (!stats) {
      const score = 0;
      if (score < bestScore) {
        bestScore = score;
        best = peerId;
      }
      continue;
    }

    if (stats.pendingRequests >= MAX_CONCURRENT_REQUESTS_PER_PEER) {
      continue; // over capacity, skip entirely
    }

    const score =
      stats.pendingRequests * WEIGHT_PENDING +
      stats.latencyEmaMs * WEIGHT_LATENCY +
      stats.recentFailures * WEIGHT_FAILURES;

    if (score < bestScore) {
      bestScore = score;
      best = peerId;
    }
  }

  return best;
}
