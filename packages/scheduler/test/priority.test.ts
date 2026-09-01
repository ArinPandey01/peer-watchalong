import { describe, it, expect } from 'vitest';
import { calculateChunkPriority, getChunkWindow } from '../src/priority';

describe('getChunkWindow', () => {
  it('splits chunks into urgent and prefetch windows relative to playhead', () => {
    // 1s chunks, playhead at t=10s -> urgent covers chunks 10-13, prefetch 14-22
    const { urgent, prefetch } = getChunkWindow(10, 1, 100);
    expect(urgent).toEqual([10, 11, 12, 13]);
    expect(prefetch).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });

  it('clamps to the end of the video near the last chunk', () => {
    const { urgent, prefetch } = getChunkWindow(98, 1, 100);
    expect(urgent[urgent.length - 1]).toBe(99);
    expect(prefetch.every((i) => i <= 99)).toBe(true);
  });

  it('clamps at the very start of the video (t=0)', () => {
    const { urgent } = getChunkWindow(0, 1, 100);
    expect(urgent[0]).toBe(0);
  });

  it('returns empty windows for degenerate input', () => {
    expect(getChunkWindow(0, 1, 0)).toEqual({ urgent: [], prefetch: [] });
    expect(getChunkWindow(0, 0, 100)).toEqual({ urgent: [], prefetch: [] });
  });
});

describe('calculateChunkPriority', () => {
  it('classifies a chunk at the playhead as URGENT', () => {
    const { tier } = calculateChunkPriority(10, 10);
    expect(tier).toBe('URGENT');
  });

  it('classifies a chunk within the prefetch window as PREFETCH', () => {
    const { tier } = calculateChunkPriority(15, 10);
    expect(tier).toBe('PREFETCH');
  });

  it('classifies a far-future chunk as IGNORED', () => {
    const { tier } = calculateChunkPriority(50, 10);
    expect(tier).toBe('IGNORED');
  });

  it('classifies a chunk behind the playhead as IGNORED', () => {
    const { tier } = calculateChunkPriority(5, 10);
    expect(tier).toBe('IGNORED');
  });

  it('closer chunks score lower (more urgent) than farther ones', () => {
    const near = calculateChunkPriority(11, 10);
    const far = calculateChunkPriority(13, 10);
    expect(near.score).toBeLessThan(far.score);
  });
});
