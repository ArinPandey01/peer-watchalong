import type { PlaybackState } from '../../protocol/control.ts';
import { ClockSynchronizer } from './clock.ts';

export type PlaybackStateUpdate = {
  accepted: boolean;
  timelineChanged: boolean;
};

export type PlaybackDecision =
  | { type: 'WAIT_FOR_STATE' | 'WAIT_FOR_CLOCK' }
  | {
      type: 'NONE' | 'ADJUST_RATE' | 'SEEK';
      targetMediaTimeSec: number;
      driftMs: number;
      playing: boolean;
      playbackRate: number;
    };

export const IN_SYNC_THRESHOLD_MS = 250;
export const SEEK_THRESHOLD_MS = 2_000;
const RATE_CORRECTION = 0.05;


export function getTargetMediaTimeSec(
  state: PlaybackState,
  trackerUnixTimeMs: number,
): number {
  if (!state.playing) {
    return state.mediaTime;
  }
  const elapsedSec = Math.max(0, trackerUnixTimeMs - state.effectiveAt) / 1_000;
  return state.mediaTime + elapsedSec * state.playbackRate;
}

export class PlaybackSynchronizer {
  private state: PlaybackState | null = null;
  private readonly clock: ClockSynchronizer;

  constructor(clock: ClockSynchronizer) {
    this.clock = clock;
  }

  applyPlaybackState(incoming: PlaybackState): PlaybackStateUpdate {
    if (
      this.state &&
      (incoming.revision < this.state.revision ||
        (incoming.revision === this.state.revision &&
          incoming.effectiveAt < this.state.effectiveAt))
    ) {
      return { accepted: false, timelineChanged: false };
    }

    const timelineChanged =
      this.state === null || incoming.revision > this.state.revision;
    this.state = { ...incoming };
    return { accepted: true, timelineChanged };
  }

  evaluate(
    localMediaTimeSec: number,
    localUnixTimeMs: number,
  ): PlaybackDecision {
    if (!Number.isFinite(localMediaTimeSec) || localMediaTimeSec < 0) {
      throw new RangeError('localMediaTimeSec must be non-negative and finite');
    }
    if (!this.state) {
      return { type: 'WAIT_FOR_STATE' };
    }
    const trackerTimeMs = this.clock.getTrackerTimeMs(localUnixTimeMs);
    if (trackerTimeMs === null && this.state.playing) {
      return { type: 'WAIT_FOR_CLOCK' };
    }

    const targetMediaTimeSec = getTargetMediaTimeSec(
      this.state,
      trackerTimeMs ?? this.state.effectiveAt,
    );
    const driftMs = (targetMediaTimeSec - localMediaTimeSec) * 1_000;
    const common = {
      targetMediaTimeSec,
      driftMs,
      playing: this.state.playing,
      playbackRate: this.state.playbackRate,
    };

    if (Math.abs(driftMs) >= SEEK_THRESHOLD_MS ||
        (!this.state.playing && Math.abs(driftMs) >= IN_SYNC_THRESHOLD_MS)) {
      return { type: 'SEEK', ...common };
    }
    if (this.state.playing && Math.abs(driftMs) >= IN_SYNC_THRESHOLD_MS) {
      const direction = driftMs > 0 ? 1 : -1;
      return {
        type: 'ADJUST_RATE',
        ...common,
        playbackRate: this.state.playbackRate *
          (1 + direction * RATE_CORRECTION),
      };
    }
    return { type: 'NONE', ...common };
  }
}
