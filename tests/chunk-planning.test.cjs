const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planNeededChunks,
  rankEligibleHolders,
} = require('../packages/scheduler/index.ts');

function uniformSegments(count, durationSec) {
  return Array.from({ length: count }, (_, index) => ({
    startTimeSec: index * durationSec,
    endTimeSec: (index + 1) * durationSec,
  }));
}

test('plans by seconds until needed with multi-second segments', () => {
  const plan = planNeededChunks(0, new Set(), {
    segments: uniformSegments(20, 2),
  });

  assert.deepEqual(plan.map(({ chunkIndex, priority, secondsUntilNeeded }) => [
    chunkIndex, priority, secondsUntilNeeded,
  ]), [
    [0, 'URGENT', 0],
    [1, 'URGENT', 2],
    [2, 'PREFETCH', 4],
    [3, 'PREFETCH', 6],
    [4, 'PREFETCH', 8],
    [5, 'PREFETCH', 10],
    [6, 'PREFETCH', 12],
    [7, 'PREFETCH', 14],
    [8, 'PREFETCH', 16],
  ]);
});

test('uses actual segment times and skips chunks already owned', () => {
  const segments = [
    { startTimeSec: 0, endTimeSec: 1.75 },
    { startTimeSec: 1.75, endTimeSec: 4.25 },
    { startTimeSec: 4.25, endTimeSec: 6.25 },
    { startTimeSec: 6.25, endTimeSec: 10.25 },
    { startTimeSec: 10.25, endTimeSec: 12 },
  ];
  const plan = planNeededChunks(5.5, new Set([2]), {
    segments,
    prefetchWindowSec: 5,
  });

  assert.deepEqual(plan, [
    { chunkIndex: 3, priority: 'URGENT', secondsUntilNeeded: 0.75 },
    { chunkIndex: 4, priority: 'PREFETCH', secondsUntilNeeded: 4.75 },
  ]);
});

test('stops at the media end and rejects invalid planning options', () => {
  const options = { segments: uniformSegments(10, 1) };
  assert.deepEqual(planNeededChunks(9.9, new Set(), options), [
    { chunkIndex: 9, priority: 'URGENT', secondsUntilNeeded: 0 },
  ]);
  assert.deepEqual(planNeededChunks(10, new Set(), options), []);
  assert.deepEqual(planNeededChunks(0, new Set(), { segments: [] }), []);
  assert.throws(() => planNeededChunks(-1, new Set(), options), /targetMediaTimeSec/);
  assert.throws(() => planNeededChunks(0, new Set(), {
    segments: [
      { startTimeSec: 0, endTimeSec: 2 },
      { startTimeSec: 1, endTimeSec: 3 },
    ],
  }), /non-overlapping/);
});

test('ranks only eligible holders by free capacity, failures, then latency', () => {
  const stats = new Map([
    ['busy', { pendingRequests: 2, recentFailures: 0, latencyEmaMs: 20 }],
    ['fast', { pendingRequests: 0, recentFailures: 0, latencyEmaMs: 30 }],
    ['unreliable', { pendingRequests: 0, recentFailures: 1, latencyEmaMs: 5 }],
    ['not-authorized', { pendingRequests: 0, recentFailures: 0, latencyEmaMs: 1 }],
  ]);

  assert.deepEqual(rankEligibleHolders(
    ['busy', 'unreliable', 'fast', 'fast'], stats,
  ), ['fast', 'unreliable', 'busy']);
});

test('skips full or excluded holders and breaks ties by peer ID', () => {
  const stats = new Map([
    ['full', { pendingRequests: 3 }],
    ['a', { pendingRequests: 0 }],
    ['b', { pendingRequests: 0 }],
  ]);

  assert.deepEqual(rankEligibleHolders(['full', 'b', 'a'], stats), ['a', 'b']);
  assert.deepEqual(rankEligibleHolders(['full', 'b', 'a'], stats, {
    excludePeerIds: new Set(['a']),
  }), ['b']);
  assert.deepEqual(rankEligibleHolders(['full'], stats), []);
  assert.deepEqual(rankEligibleHolders([], stats), []);
});
