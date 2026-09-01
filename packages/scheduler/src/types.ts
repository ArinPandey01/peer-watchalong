import { PeerId } from '../../protocol/control';
export type ChunkIndex = number;

/** Priority tier a chunk falls into relative to the current playhead. */
export type ChunkPriorityTier = 'URGENT' | 'PREFETCH' | 'IGNORED';

/** Result of the drift evaluation for the current tick. */
export type DriftDecision =
  | { type: 'NONE' }
  | { type: 'ADJUST_RATE'; rate: number; driftMs: number }
  | { type: 'HARD_SEEK'; targetMediaTimeMs: number; driftMs: number };

/** A single clock-sync sample derived from one CLOCK_SYNC_REQ/RES round trip. */
export interface ClockSample {
  offsetMs: number; // tracker_time - local_time
  rttMs: number;
  sampledAt: number; // local clock time this sample was taken
}

/** Rolling performance stats the scheduler keeps per peer for holder selection. */
export interface PeerPerformance {
  peerId: PeerId;
  pendingRequests: number;
  latencyEmaMs: number;
  recentFailures: number; // decayed count, see retry.ts
  lastFailureAt?: number;
}

/** An in-flight chunk request tracked by RetryManager. */
export interface InFlightRequest {
  chunkIndex: ChunkIndex;
  peerId: PeerId;
  requestId: string;
  sentAt: number;
  timeoutMs: number;
  retryCount: number;
  epoch: number;
}

export interface ExpiredRequest {
  chunkIndex: ChunkIndex;
  peerId: PeerId;
  requestId: string;
  retryCount: number;
}

/** Commands the scheduler emits each tick for the host app to actually execute. */
export interface RequestChunkCommand {
  type: 'REQUEST_CHUNK';
  chunkIndex: ChunkIndex;
  peerId: PeerId;
  requestId: string;
  epoch: number;
}

export interface CancelChunkCommand {
  type: 'CANCEL_CHUNK';
  chunkIndex: ChunkIndex;
  peerId: PeerId;
  requestId: string;
}

export type SchedulerCommand = RequestChunkCommand | CancelChunkCommand;

export interface SchedulerCommands {
  commands: SchedulerCommand[];
  drift: DriftDecision;
}
