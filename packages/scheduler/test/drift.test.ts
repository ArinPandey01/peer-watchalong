import { describe, it, expect } from 'vitest';
import { calculateTargetMediaTime, evaluateDrift } from '../src/drift';
import { PlaybackState } from '../src/protocol-types';

describe('calculateTargetMediaTime', () => {
  it('returns mediaTime unchanged when paused', () => {
    const state: PlaybackState = {
      playing: false,
      mediaTime: 5000,
      effectiveAt: 1000,
      playbackRate: 1,
      revision: 1,
    };
    expect(calculateTargetMediaTime(state, 9999)).toBe(5000);
  });

  it('advances mediaTime by elapsed time * rate when playing', () => {
    const state: PlaybackState = {
      playing: true,
      mediaTime: 5000,
      effectiveAt: 1000,
      playbackRate: 1,
      revision: 1,
    };
    // 2000ms elapsed since effectiveAt
    expect(calculateTargetMediaTime(state, 3000)).toBe(7000);
  });

  it('respects a non-1x playback rate', () => {
    const state: PlaybackState = {
      playing: true,
      mediaTime: 0,
      effectiveAt: 0,
      playbackRate: 2,
      revision: 1,
    };
    expect(calculateTargetMediaTime(state, 1000)).toBe(2000);
  });
});

describe('evaluateDrift', () => {
  it('returns NONE when drift is under the in-sync threshold', () => {
    expect(evaluateDrift(10000, 9970)).toEqual({ type: 'NONE' });
  });

  it('returns ADJUST_RATE (speed up) when local is behind target', () => {
    const result = evaluateDrift(10000, 10200); // 200ms behind
    expect(result.type).toBe('ADJUST_RATE');
    if (result.type === 'ADJUST_RATE') {
      expect(result.rate).toBeGreaterThan(1);
    }
  });

  it('returns ADJUST_RATE (slow down) when local is ahead of target', () => {
    const result = evaluateDrift(10200, 10000); // 200ms ahead
    expect(result.type).toBe('ADJUST_RATE');
    if (result.type === 'ADJUST_RATE') {
      expect(result.rate).toBeLessThan(1);
    }
  });

  it('returns HARD_SEEK when drift exceeds the hard-seek threshold', () => {
    const result = evaluateDrift(10000, 10600); // 600ms behind
    expect(result.type).toBe('HARD_SEEK');
    if (result.type === 'HARD_SEEK') {
      expect(result.targetMediaTimeMs).toBe(10600);
    }
  });

  it('treats the thresholds as boundaries correctly', () => {
    expect(evaluateDrift(1000, 1039).type).toBe('NONE'); // 39ms
    expect(evaluateDrift(1000, 1040).type).toBe('ADJUST_RATE'); // 40ms
    expect(evaluateDrift(1000, 1399).type).toBe('ADJUST_RATE'); // 399ms
    expect(evaluateDrift(1000, 1400).type).toBe('HARD_SEEK'); // 400ms
  });
});
