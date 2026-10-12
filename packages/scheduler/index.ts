export {
  ClockSynchronizer,
  type ClockSample,
  type ClockSyncResponsePayload,
} from './src/clock.ts';

export {
  PlaybackSynchronizer,
  getTargetMediaTimeSec,
  IN_SYNC_THRESHOLD_MS,
  SEEK_THRESHOLD_MS,
  type PlaybackDecision,
  type PlaybackStateUpdate,
} from './src/playback-sync.ts';

export {
  planNeededChunks,
  DEFAULT_URGENT_WINDOW_SEC,
  DEFAULT_PREFETCH_WINDOW_SEC,
  type ChunkPlanningOptions,
  type ChunkPriority,
  type MediaSegmentTime,
  type PlannedChunk,
} from './src/chunk-planning.ts';

export {
  rankEligibleHolders,
  DEFAULT_MAX_CONCURRENT_REQUESTS_PER_PEER,
  type HolderSelectionOptions,
  type PeerPerformance,
} from './src/holder-selection.ts';
