import { PlaybackState } from '../../protocol/control';
import { DriftDecision } from './types';

/** Below this |drift|, do nothing — normal playback jitter. */
export const IN_SYNC_THRESHOLD_MS = 40;
/** At/above this |drift|, stop nudging the rate and hard-seek instead. */
export const HARD_SEEK_THRESHOLD_MS = 400;

const RATE_BEHIND = 1.03; // speed up when we're behind the host
const RATE_AHEAD = 0.97; // slow down when we're ahead of the host

/**
 * Computes where the local playhead *should* be right now, given the
 * canonical PlaybackState from the tracker and the current estimated
 * tracker time.
 */
export function calculateTargetMediaTime(
  canonicalState: PlaybackState,
  currentTrackerTimeMs: number
): number {
  if (!canonicalState.playing) {
    return canonicalState.mediaTime;
  }
  const elapsed = currentTrackerTimeMs - canonicalState.effectiveAt;
  return canonicalState.mediaTime + elapsed * canonicalState.playbackRate;
}

/**
 * Compares the local playhead against the target and decides what
 * corrective action (if any) to take.
 */
export function evaluateDrift(
  currentLocalMediaTimeMs: number,
  targetMediaTimeMs: number
): DriftDecision {
  const driftMs = currentLocalMediaTimeMs - targetMediaTimeMs; // positive = we're ahead

  const absDrift = Math.abs(driftMs);

  if (absDrift < IN_SYNC_THRESHOLD_MS) {
    return { type: 'NONE' };
  }

  if (absDrift < HARD_SEEK_THRESHOLD_MS) {
    // We're ahead -> slow down. We're behind -> speed up.
    const rate = driftMs > 0 ? RATE_AHEAD : RATE_BEHIND;
    return { type: 'ADJUST_RATE', rate, driftMs };
  }

  return { type: 'HARD_SEEK', targetMediaTimeMs, driftMs };
}
