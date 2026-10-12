const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ClockSynchronizer,
  PlaybackSynchronizer,
  getTargetMediaTimeSec,
} = require('../packages/scheduler/index.ts');

function addGoodSample(clock) {
  // 20 ms each way, with the tracker clock 50 ms ahead.
  return clock.addSample({
    clientSentAt: 1000,
    trackerReceivedAt: 1070,
    trackerSentAt: 1070,
  }, 1040);
}

function playbackState(overrides = {}) {
  return {
    playing: true,
    mediaTime: 10,
    effectiveAt: 1000,
    playbackRate: 1,
    revision: 1,
    ...overrides,
  };
}

test('estimates tracker time from the lowest-latency clock samples', () => {
  const clock = new ClockSynchronizer();
  assert.equal(clock.getTrackerTimeMs(2000), null);

  assert.deepEqual(addGoodSample(clock), {
    offsetMs: 50,
    roundTripMs: 40,
    receivedAtMs: 1040,
  });
  // This 400 ms round trip suggests an inaccurate 800 ms offset.
  clock.addSample({
    clientSentAt: 2000,
    trackerReceivedAt: 3000,
    trackerSentAt: 3000,
  }, 2400);

  assert.equal(clock.getOffsetMs(), 50);
  assert.equal(clock.getTrackerTimeMs(2000), 2050);
});

test('rejects invalid clock samples and expires old ones', () => {
  const clock = new ClockSynchronizer(1);
  assert.equal(addGoodSample(clock).offsetMs, 50);
  assert.equal(clock.addSample({
    clientSentAt: 1000,
    trackerReceivedAt: 1070,
    trackerSentAt: 1100,
  }, 1020), null); // Server processing exceeds the observed round trip.
  assert.equal(clock.getOffsetMs(), 50);

  clock.addSample({
    clientSentAt: 2000,
    trackerReceivedAt: 2060,
    trackerSentAt: 2060,
  }, 2040);
  assert.equal(clock.getOffsetMs(), 40);
  clock.clear();
  assert.equal(clock.getOffsetMs(), null);
  assert.throws(() => new ClockSynchronizer(0), /positive integer/);
});

test('converts tracker milliseconds into media seconds', () => {
  assert.equal(getTargetMediaTimeSec(playbackState(), 3000), 12);
  assert.equal(getTargetMediaTimeSec(playbackState({ playbackRate: 1.5 }), 3000), 13);
  assert.equal(getTargetMediaTimeSec(playbackState({ playing: false }), 3000), 10);
});

test('returns drift decisions and restores the canonical rate in sync', () => {
  const clock = new ClockSynchronizer();
  const sync = new PlaybackSynchronizer(clock);
  assert.deepEqual(sync.evaluate(10, 2950), { type: 'WAIT_FOR_STATE' });
  assert.deepEqual(sync.applyPlaybackState(playbackState()), {
    accepted: true,
    timelineChanged: true,
  });
  assert.deepEqual(sync.evaluate(10, 2950), { type: 'WAIT_FOR_CLOCK' });
  addGoodSample(clock); // Local 2950 ms corresponds to tracker 3000 ms.

  const inSync = sync.evaluate(11.8, 2950);
  assert.equal(inSync.type, 'NONE');
  assert.equal(inSync.playbackRate, 1);

  const behind = sync.evaluate(11.7, 2950);
  assert.equal(behind.type, 'ADJUST_RATE');
  assert.equal(behind.playbackRate, 1.05);

  const ahead = sync.evaluate(12.3, 2950);
  assert.equal(ahead.type, 'ADJUST_RATE');
  assert.equal(ahead.playbackRate, 0.95);

  const seek = sync.evaluate(9.5, 2950);
  assert.equal(seek.type, 'SEEK');
  assert.equal(seek.targetMediaTimeSec, 12);
});

test('accepts play/pause updates at the same revision without changing timeline', () => {
  const sync = new PlaybackSynchronizer(new ClockSynchronizer());
  sync.applyPlaybackState(playbackState());

  assert.deepEqual(sync.applyPlaybackState(playbackState({
    playing: false,
    mediaTime: 12,
    effectiveAt: 3000,
  })), { accepted: true, timelineChanged: false });
  // A paused target can be applied before a clock sample arrives.
  const paused = sync.evaluate(11, 2950);
  assert.equal(paused.type, 'SEEK');
  assert.equal(paused.playing, false);
  assert.equal(paused.targetMediaTimeSec, 12);

  assert.deepEqual(sync.applyPlaybackState(playbackState({
    playing: true,
    effectiveAt: 2000,
  })), { accepted: false, timelineChanged: false });
  assert.deepEqual(sync.applyPlaybackState(playbackState({
    revision: 2,
    effectiveAt: 4000,
  })), { accepted: true, timelineChanged: true });
});

test('a host seek at a higher revision forces a seek even below the drift threshold', () => {
  const clock = new ClockSynchronizer();
  const sync = new PlaybackSynchronizer(clock);
  clock.addSample({
    clientSentAt: 1000,
    trackerReceivedAt: 1070,
    trackerSentAt: 1070,
  }, 1040);
  sync.applyPlaybackState(playbackState({ mediaTime: 10, effectiveAt: 3000 }));

  assert.deepEqual(sync.applyPlaybackState(playbackState({
    mediaTime: 10.5,
    effectiveAt: 3000,
    revision: 2,
  })), { accepted: true, timelineChanged: true });

  const seek = sync.evaluate(10, 2950);
  assert.equal(seek.type, 'SEEK');
  assert.equal(seek.targetMediaTimeSec, 10.5);
  assert.equal(sync.evaluate(10, 2950).type, 'SEEK');
  assert.equal(sync.evaluate(10.5, 2950).type, 'NONE');
});

test('a tiny intentional host seek still produces a seek decision', () => {
  const clock = new ClockSynchronizer();
  const sync = new PlaybackSynchronizer(clock);
  clock.addSample({
    clientSentAt: 1000, trackerReceivedAt: 1070, trackerSentAt: 1070,
  }, 1040);
  sync.applyPlaybackState(playbackState({ effectiveAt: 3000 }));
  sync.applyPlaybackState(playbackState({
    mediaTime: 10.1, effectiveAt: 3000, revision: 2,
  }));
  assert.equal(sync.evaluate(10, 2950).type, 'SEEK');
});
