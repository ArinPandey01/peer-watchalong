export type ChunkPriority = 'URGENT' | 'PREFETCH';

export interface PlannedChunk {
  chunkIndex: number;
  priority: ChunkPriority;
  secondsUntilNeeded: number;
}

/** The array position of a segment is its chunkIndex on the wire. */
export interface MediaSegmentTime {
  startTimeSec: number;
  endTimeSec: number;
}

export interface ChunkPlanningOptions {
  segments: readonly MediaSegmentTime[];
  urgentWindowSec?: number;
  prefetchWindowSec?: number;
}

export const DEFAULT_URGENT_WINDOW_SEC = 3;
export const DEFAULT_PREFETCH_WINDOW_SEC = 16;

export function planNeededChunks(
  targetMediaTimeSec: number,
  ownedChunks: ReadonlySet<number>,
  options: ChunkPlanningOptions,
): PlannedChunk[] {
  const {
    segments,
    urgentWindowSec = DEFAULT_URGENT_WINDOW_SEC,
    prefetchWindowSec = DEFAULT_PREFETCH_WINDOW_SEC,
  } = options;

  if (!Number.isFinite(targetMediaTimeSec) || targetMediaTimeSec < 0) {
    throw new RangeError('targetMediaTimeSec must be non-negative and finite');
  }
  if (!Number.isFinite(urgentWindowSec) || urgentWindowSec < 0 ||
      !Number.isFinite(prefetchWindowSec) ||
      prefetchWindowSec < urgentWindowSec) {
    throw new RangeError('chunk windows must be finite, non-negative, and ordered');
  }
  let previousEndTimeSec = 0;
  for (const segment of segments) {
    if (!Number.isFinite(segment.startTimeSec) ||
        !Number.isFinite(segment.endTimeSec) ||
        segment.startTimeSec < previousEndTimeSec ||
        segment.endTimeSec <= segment.startTimeSec) {
      throw new RangeError('segments must have ordered, non-overlapping time ranges');
    }
    previousEndTimeSec = segment.endTimeSec;
  }

  const plan: PlannedChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < segments.length; chunkIndex++) {
    const segment = segments[chunkIndex];
    if (!segment || segment.endTimeSec <= targetMediaTimeSec) {
      continue;
    }
    if (segment.startTimeSec > targetMediaTimeSec + prefetchWindowSec) {
      break;
    }
    if (ownedChunks.has(chunkIndex)) {
      continue;
    }

    const secondsUntilNeeded = Math.max(
      0,
      segment.startTimeSec - targetMediaTimeSec,
    );
    plan.push({
      chunkIndex,
      priority: secondsUntilNeeded <= urgentWindowSec
        ? 'URGENT'
        : 'PREFETCH',
      secondsUntilNeeded,
    });
  }

  return plan;
}
