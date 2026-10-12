import type { ClockSyncRes } from '../../protocol/control.ts';

export type ClockSyncResponsePayload = ClockSyncRes['payload'];

export interface ClockSample {
  offsetMs: number;
  roundTripMs: number;
  receivedAtMs: number;
}

const DEFAULT_WINDOW_SIZE = 8;
const MAX_RTT_MULTIPLIER = 1.5;


export class ClockSynchronizer {
  private readonly windowSize: number;
  private readonly samples: ClockSample[] = [];

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    if (!Number.isSafeInteger(windowSize) || windowSize <= 0) {
      throw new RangeError('windowSize must be a positive integer');
    }
    this.windowSize = windowSize;
  }


  addSample(
    response: ClockSyncResponsePayload,
    clientReceivedAtMs: number,
  ): ClockSample | null {
    const { clientSentAt, trackerReceivedAt, trackerSentAt } = response;
    if (
      ![clientSentAt, trackerReceivedAt, trackerSentAt, clientReceivedAtMs]
        .every(Number.isFinite) ||
      clientReceivedAtMs < clientSentAt ||
      trackerSentAt < trackerReceivedAt
    ) {
      return null;
    }

    const roundTripMs =
      clientReceivedAtMs - clientSentAt -
      (trackerSentAt - trackerReceivedAt);
    if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
      return null;
    }

    const offsetMs =
      ((trackerReceivedAt - clientSentAt) +
        (trackerSentAt - clientReceivedAtMs)) / 2;
    if (!Number.isFinite(offsetMs)) {
      return null;
    }
    const sample = {
      offsetMs,
      roundTripMs,
      receivedAtMs: clientReceivedAtMs,
    };

    this.samples.push(sample);
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
    return sample;
  }

  getOffsetMs(): number | null {
    if (this.samples.length === 0) {
      return null;
    }

    const bestRoundTripMs = Math.min(...this.samples.map(
      (sample) => sample.roundTripMs,
    ));
    const offsets = this.samples
      .filter((sample) =>
        sample.roundTripMs <= bestRoundTripMs * MAX_RTT_MULTIPLIER,
      )
      .map((sample) => sample.offsetMs)
      .sort((a, b) => a - b);
    const middle = Math.floor(offsets.length / 2);
    if (offsets.length % 2 === 1) {
      return offsets[middle] ?? null;
    }
    return ((offsets[middle - 1] ?? 0) + (offsets[middle] ?? 0)) / 2;
  }

  getTrackerTimeMs(localUnixTimeMs: number): number | null {
    if (!Number.isFinite(localUnixTimeMs)) {
      throw new RangeError('localUnixTimeMs must be finite');
    }
    const offsetMs = this.getOffsetMs();
    return offsetMs === null ? null : localUnixTimeMs + offsetMs;
  }

  clear(): void {
    this.samples.length = 0;
  }
}
