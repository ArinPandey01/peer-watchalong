import { ChunkIndex } from './types';
import { ChunkPriorityTier } from './types';

/** Chunks needed in the next N seconds get single-peer, low-timeout requests. */
export const URGENT_WINDOW_SEC = 3;
/** Chunks needed within this horizon are prefetched concurrently. */
export const PREFETCH_WINDOW_SEC = 12;

export interface ChunkWindow {
  urgent: ChunkIndex[];
  prefetch: ChunkIndex[];
}

function clampChunkIndex(index: number, totalChunks: number): number {
  return Math.max(0, Math.min(totalChunks - 1, index));
}

/**
 * Computes which chunk indices fall in the urgent and prefetch windows
 * ahead of the current playhead.
 */
export function getChunkWindow(
  targetMediaTimeSec: number,
  chunkDurationSec: number,
  totalChunks: number
): ChunkWindow {
  if (totalChunks <= 0 || chunkDurationSec <= 0) {
    return { urgent: [], prefetch: [] };
  }

  const playheadChunk = clampChunkIndex(
    Math.floor(Math.max(0, targetMediaTimeSec) / chunkDurationSec),
    totalChunks
  );

  const urgentEndChunk = clampChunkIndex(
    Math.floor((targetMediaTimeSec + URGENT_WINDOW_SEC) / chunkDurationSec),
    totalChunks
  );

  const prefetchEndChunk = clampChunkIndex(
    Math.floor((targetMediaTimeSec + PREFETCH_WINDOW_SEC) / chunkDurationSec),
    totalChunks
  );

  const urgent: ChunkIndex[] = [];
  for (let i = playheadChunk; i <= urgentEndChunk; i++) urgent.push(i);

  const prefetch: ChunkIndex[] = [];
  for (let i = urgentEndChunk + 1; i <= prefetchEndChunk; i++) prefetch.push(i);

  return { urgent, prefetch };
}

/**
 * Classifies a single chunk relative to the current playhead chunk.
 * Lower numeric priority = more urgent (0 is not used; 1 = urgent, 2 = prefetch).
 */
export function calculateChunkPriority(
  chunkIndex: ChunkIndex,
  currentPlayheadChunk: ChunkIndex
): { tier: ChunkPriorityTier; score: number } {
  if (chunkIndex < currentPlayheadChunk) {
    // Already behind the playhead — no longer useful.
    return { tier: 'IGNORED', score: Number.POSITIVE_INFINITY };
  }

  const distance = chunkIndex - currentPlayheadChunk;

  if (distance <= URGENT_WINDOW_SEC) {
    return { tier: 'URGENT', score: distance };
  }

  if (distance <= PREFETCH_WINDOW_SEC) {
    return { tier: 'PREFETCH', score: distance };
  }

  return { tier: 'IGNORED', score: Number.POSITIVE_INFINITY };
}
