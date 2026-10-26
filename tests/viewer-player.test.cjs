const test = require('node:test');
const assert = require('node:assert/strict');
const { ViewerPlayer } = require('../apps/web/src/viewer-player.ts');
const { encodeMediaBundle } = require('../apps/web/src/media-bundle.ts');

class FakeSourceBuffer extends EventTarget {
  updating = false;
  writes = [];
  removals = [];
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

  remove(start, end) {
    this.removals.push([start, end]);
    this.updating = true;
    queueMicrotask(() => {
      this.ranges = this.ranges.flatMap(([from, to]) =>
        to <= end ? [] : [[Math.max(from, end), to]]);
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

test('an interrupted play request does not permanently fail viewer playback', async () => {
  const { video, source, player } = setup();
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  player.receiveChunk(1, Uint8Array.of(1));
  await drain();

  let rejectPlay;
  video.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const playing = { type: 'NONE', targetMediaTimeSec: 2, driftMs: 0,
    playing: true, playbackRate: 1 };
  player.applyDecision(playing);
  player.applyDecision({ ...playing, playing: false });
  rejectPlay(new DOMException('Playback interrupted', 'AbortError'));
  await drain();

  video.play = () => { video.paused = false; return Promise.resolve(); };
  player.applyDecision(playing);
  await drain();
  assert.equal(video.paused, false);
  player.close();
});

test('updates a media window without replacing the player and evicts old buffer', async () => {
  const { video, source, player } = setup();
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  player.receiveChunk(1, Uint8Array.of(1));
  await drain();

  video.currentTime = 12;
  player.updateManifest({
    mediaId: 'media-1', durationSec: 20,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0 },
      { chunkIndex: 2, trackId: 1, kind: 'media', startTimeSec: 10, endTimeSec: 20 },
    ],
  });
  player.receiveChunk(2, Uint8Array.of(2));
  await drain();
  assert.deepEqual(source.buffers[0].removals, [[0, 6]]);
  assert.deepEqual(source.buffers[0].writes, [0, 1, 2]);
  player.applyDecision({ type: 'NONE', targetMediaTimeSec: 12, driftMs: 0,
    playing: true, playbackRate: 1 });
  assert.equal(video.paused, false);
  player.close();
});

test('one media bundle supplies the video and audio source buffers', async () => {
  const video = new FakeVideo();
  const source = new FakeMediaSource();
  const data = encodeMediaBundle([
    { trackId: 1, data: Uint8Array.of(1) },
    { trackId: 2, data: Uint8Array.of(1) },
  ]);
  const manifest = {
    mediaId: 'bundled', durationSec: 10,
    tracks: [
      { id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' },
      { id: 2, kind: 'audio', mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
    ],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0 },
      { chunkIndex: 1, trackId: 2, kind: 'init', startTimeSec: 0, endTimeSec: 0 },
      { chunkIndex: 2, kind: 'media', startTimeSec: 0, endTimeSec: 10,
        parts: [
          { trackId: 1, startTimeSec: 0, endTimeSec: 10, byteLength: 1 },
          { trackId: 2, startTimeSec: 0, endTimeSec: 10, byteLength: 1 },
        ] },
    ],
  };
  let error;
  const player = new ViewerPlayer(video, manifest, {
    supportsType: () => true,
    createMediaSource: () => source,
    createObjectUrl: () => 'blob:test',
    revokeObjectUrl: () => {},
    onError: (value) => { error = value; },
  });
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  player.receiveChunk(1, Uint8Array.of(0));
  player.receiveChunk(2, data);
  await drain();
  assert.deepEqual(source.buffers.map((buffer) => buffer.writes), [[0, 1], [0, 1]]);
  player.applyDecision({ type: 'SEEK', targetMediaTimeSec: 5, driftMs: 5000,
    playing: true, playbackRate: 1 });
  assert.equal(video.paused, false);
  assert.equal(error, undefined);
  player.close();
});

test('a backward window cancels an unfinished forward eviction', async () => {
  const { source, player } = setup();
  source.open();
  player.receiveChunk(0, Uint8Array.of(0));
  await drain();
  player.receiveChunk(1, Uint8Array.of(1));
  const original = {
    mediaId: 'media-1', durationSec: 20,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0 },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 10 },
    ],
  };
  player.updateManifest({ ...original, chunks: [original.chunks[0],
    { chunkIndex: 2, trackId: 1, kind: 'media', startTimeSec: 10, endTimeSec: 20 }] });
  player.updateManifest(original);
  await drain();
  assert.deepEqual(source.buffers[0].removals, []);
  player.close();
});
