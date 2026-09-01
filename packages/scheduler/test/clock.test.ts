import { describe, it, expect } from 'vitest';
import { ClockSynchronizer } from '../src/clock';

// Fixture derivation: one-way network delay D=20ms, true clock offset OFF=50ms,
// zero tracker processing time.
//   T1 (clientSentAt)     = 1000
//   T2 (trackerReceivedAt)= T1 + OFF + D = 1070
//   T3 (trackerSentAt)    = T2 + 0       = 1070
//   T4 (clientReceivedAt) = T1 + 2*D     = 1040
// Expected: RTT = 2*D = 40, offset = OFF = 50

describe('ClockSynchronizer', () => {
  it('computes the correct offset and RTT for a symmetric round trip', () => {
    const clock = new ClockSynchronizer();
    const sample = clock.processSyncSample(1000, 1070, 1070, 1040);

    expect(sample.rttMs).toBe(40);
    expect(sample.offsetMs).toBeCloseTo(50, 5);
  });

  it('estimates tracker time as local time plus offset', () => {
    const clock = new ClockSynchronizer();
    clock.processSyncSample(1000, 1070, 1070, 1040); // offset = 50
    expect(clock.getEstimatedTrackerTime(2000)).toBeCloseTo(2050, 5);
  });

  it('returns 0 offset when no samples exist yet', () => {
    const clock = new ClockSynchronizer();
    expect(clock.getEstimatedOffset()).toBe(0);
    expect(clock.hasSamples()).toBe(false);
  });

  it('keeps only the last N samples in the rolling window', () => {
    const clock = new ClockSynchronizer(3);
    for (let i = 0; i < 5; i++) {
      clock.processSyncSample(1000 + i, 1070 + i, 1070 + i, 1040 + i);
    }
    // @ts-expect-error accessing private for test verification
    expect(clock['samples'].length).toBe(3);
  });

  it('filters out samples with wildly inflated RTT (outliers)', () => {
    const clock = new ClockSynchronizer();
    // Several good samples around offset 50, RTT 40
    for (let i = 0; i < 5; i++) {
      clock.processSyncSample(1000, 1070, 1070, 1040);
    }
    // One bad sample with a huge RTT and a very different offset
    clock.processSyncSample(2000, 2070, 9000, 12000);

    const offset = clock.getEstimatedOffset();
    // Should stay close to 50, not get dragged toward the outlier's offset
    expect(offset).toBeGreaterThan(30);
    expect(offset).toBeLessThan(70);
  });

  it('reset() clears all samples', () => {
    const clock = new ClockSynchronizer();
    clock.processSyncSample(1000, 1070, 1070, 1040);
    clock.reset();
    expect(clock.hasSamples()).toBe(false);
    expect(clock.getEstimatedOffset()).toBe(0);
  });
});
