import { ClockSynchronizer } from './clock';
import { calculateTargetMediaTime, evaluateDrift } from './drift';
import { PlaybackState } from '../../protocol/control';
import { DriftDecision } from './types';

/**
 * Owns the currently-known canonical PlaybackState and rejects stale
 * updates by revision number. The tracker is authoritative — this class
 * never invents or mutates playback state, only consumes it.
 */
export class SyncManager {
  private current: PlaybackState | null = null;
  private readonly clock: ClockSynchronizer;

  constructor(clock: ClockSynchronizer = new ClockSynchronizer()) {
    this.clock = clock;
  }

  getClock(): ClockSynchronizer {
    return this.clock;
  }

  getCurrentState(): PlaybackState | null {
    return this.current;
  }

  /**
   * Applies an incoming PlaybackState (from PLAYBACK_STATE_RES/EVENT).
   * Returns true if it was accepted, false if it was stale and dropped.
   */
  applyPlaybackState(incoming: PlaybackState): boolean {
    if (this.current && incoming.revision < this.current.revision) {
      return false; // stale — tracker already told us something newer
    }
    this.current = incoming;
    return true;
  }

  /** True if `revision` is newer than whatever we currently hold. */
  isNewRevision(revision: number): boolean {
    return this.current === null || revision > this.current.revision;
  }

  /**
   * Given the local media element's current time (ms) and a local clock
   * reading, returns the drift decision for this tick. Returns null if we
   * don't yet have a canonical state to compare against.
   */
  evaluate(localMediaTimeMs: number, localNow: number = Date.now()): DriftDecision | null {
    if (!this.current) return null;
    const trackerNow = this.clock.getEstimatedTrackerTime(localNow);
    const target = calculateTargetMediaTime(this.current, trackerNow);
    return evaluateDrift(localMediaTimeMs, target);
  }
}
