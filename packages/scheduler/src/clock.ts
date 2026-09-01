import { ClockSample } from './types';

const DEFAULT_WINDOW_SIZE = 8;
const OUTLIER_RTT_MULTIPLIER = 1.5;

/**
 * Estimates the offset between local clock and tracker clock using
 * Cristian's algorithm, fed by CLOCK_SYNC_REQ/RES round trips.
 *
 *   T1 = clientSentAt        (local time request was sent)
 *   T2 = trackerReceivedAt   (tracker time request arrived)
 *   T3 = trackerSentAt       (tracker time response was sent)
 *   T4 = clientReceivedAt    (local time response arrived)
 *
 *   RTT    = (T4 - T1) - (T3 - T2)
 *   offset = ((T2 - T1) + (T3 - T4)) / 2      // tracker_time - local_time
 */
export class ClockSynchronizer {
  private samples: ClockSample[] = [];
  private readonly windowSize: number;

  constructor(windowSize: number = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  /**
   * Processes one completed CLOCK_SYNC_REQ/RES round trip and returns the
   * derived sample. Outlier samples (RTT > 1.5x the current best RTT) are
   * still returned but excluded from the offset estimate.
   */
  processSyncSample(
    clientSentAt: number,
    trackerReceivedAt: number,
    trackerSentAt: number,
    clientReceivedAt: number
  ): ClockSample {
    const rttMs = clientReceivedAt - clientSentAt - (trackerSentAt - trackerReceivedAt);
    const offsetMs =
      ((trackerReceivedAt - clientSentAt) + (trackerSentAt - clientReceivedAt)) / 2;

    const sample: ClockSample = { offsetMs, rttMs, sampledAt: clientReceivedAt };

    this.samples.push(sample);
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    return sample;
  }

  /** Samples currently retained in the rolling window, best-RTT-filtered. */
  private getFilteredSamples(): ClockSample[] {
    if (this.samples.length === 0) return [];
    const minRtt = Math.min(...this.samples.map((s) => s.rttMs));
    // Guard against a degenerate 0/negative minRtt (e.g. clock jitter in tests).
    const threshold = Math.max(minRtt, 0) * OUTLIER_RTT_MULTIPLIER;
    const filtered = this.samples.filter((s) => s.rttMs <= threshold || minRtt <= 0);
    return filtered.length > 0 ? filtered : this.samples;
  }

  /** Weighted-median offset estimate across the filtered sample window (ms). */
  getEstimatedOffset(): number {
    const filtered = this.getFilteredSamples();
    if (filtered.length === 0) return 0;

    const sorted = [...filtered].sort((a, b) => a.offsetMs - b.offsetMs);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[mid].offsetMs;
    }
    return (sorted[mid - 1].offsetMs + sorted[mid].offsetMs) / 2;
  }

  /** Best (lowest) RTT currently observed, or null if no samples yet. */
  getBestRttMs(): number | null {
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples.map((s) => s.rttMs));
  }

  /** Estimated current tracker time given a local timestamp (defaults to now). */
  getEstimatedTrackerTime(localNow: number = Date.now()): number {
    return localNow + this.getEstimatedOffset();
  }

  hasSamples(): boolean {
    return this.samples.length > 0;
  }

  reset(): void {
    this.samples = [];
  }
}
