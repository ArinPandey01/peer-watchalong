const test = require('node:test');
const assert = require('node:assert/strict');
const { ViewerPlayer } = require('../apps/web/src/viewer-player.ts');

class FakeSourceBuffer extends EventTarget {
  updating = false;
  writes = [];
  ranges = [];

  get buffered() {
    return {
      length: this.ranges.length,
      start: (index) => this.ranges[index][0],
      end: (index) => this.ranges[index][1],
    };
  }

  appendBuffer(data) {
    this.updating = true;
    const index = data[0];
    this.writes.push(index);
    queueMicrotask(() => {
      if (index > 0) this.ranges.push([(index - 1) * 10, index * 10]);
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    });
  }
}

class FakeMediaSource extends EventTarget {
  readyState = 'closed';
  buffers = [];

  addSourceBuffer() {
    const buffer = new FakeSourceBuffer();
    this.buffers.push(buffer);
    return buffer;
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }
}

class FakeVideo extends EventTarget {
  currentTime = 0;
  playbackRate = 1;
  paused = true;

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  removeAttribute() {}
  load() {}
}

function setup() {
  const video = new FakeVideo();
  const source = new FakeMediaSource();
  let revoked = false;
  const manifest = {
    mediaId: 'media-1', durationSec: 20,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0 },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 10 },
      { chunkIndex: 2, trackId: 1, kind: 'media', startTimeSec: 10, endTimeSec: 20 },
    ],
  };
  const player = new ViewerPlayer(video, manifest, {
    supportsType: () => true,
    createMediaSource: () => source,
    createObjectUrl: () => 'blob:test',
    revokeObjectUrl: () => { revoked = true; },
  });
  return { video, source, player, wasRevoked: () => revoked };
}

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('appends initialization before media and waits for missing earlier segments', async () => {
  const { source, player } = setup();
  player.receiveChunk(2, Uint8Array.of(2));
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  await drain();
  assert.deepEqual(source.buffers[0].writes, [0]);
  player.receiveChunk(1, Uint8Array.of(1));
  await drain();
  assert.deepEqual(source.buffers[0].writes, [0, 1, 2]);
  player.close();
});

test('host seek skips old segments and starts playing after target is buffered', async () => {
  const { video, source, player, wasRevoked } = setup();
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  player.receiveChunk(2, Uint8Array.of(2));
  player.applyDecision({ type: 'SEEK', targetMediaTimeSec: 12, driftMs: 12000,
    playing: true, playbackRate: 1 });
  await drain();
  assert.deepEqual(source.buffers[0].writes, [0, 2]);
  player.applyDecision({ type: 'SEEK', targetMediaTimeSec: 12, driftMs: 12000,
    playing: true, playbackRate: 1 });
  assert.equal(video.currentTime, 12);
  assert.equal(video.paused, false);
  player.applyDecision({ type: 'NONE', targetMediaTimeSec: 12, driftMs: 0,
    playing: false, playbackRate: 1 });
  assert.equal(video.paused, true);
  player.close();
  assert.equal(wasRevoked(), true);
});
