const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackerRequestError } = require('../packages/tracker-client/src/tracker-client.ts');
const { RoomController } = require('../apps/web/src/room-controller.ts');
const { HostPlaybackPublisher } = require('../apps/web/src/host-playback.ts');
const {
  generateRoomCode,
  normalizeRoomCode,
  displayRoomCode,
} = require('../apps/web/src/room-code.ts');

class FakeTracker {
  listeners = new Map();
  created = [];
  joined = [];
  playbackUpdates = [];
  media = null;
  announcedChunks = [];
  playbackState = {
    playing: false, mediaTime: 0, playbackRate: 1, revision: 0, effectiveAt: 1000,
  };
  disconnected = false;
  connectResult = Promise.resolve();
  createResult = async () => {};
  joinResult = async () => {};

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  connect() { return this.connectResult; }
  async createRoom(code) {
    this.created.push(code);
    await this.createResult(code);
    return { payload: { resumeToken: 'test-resume-token' } };
  }
  async resumeHost() { return { payload: { assignedPeerId: 'host' } }; }
  async joinRoom(code) { this.joined.push(code); await this.joinResult(code); }
  requestPlaybackState() { return Promise.resolve({ payload: { state: this.playbackState } }); }
  requestMedia() { return Promise.resolve({ payload: { manifest: this.media } }); }
  setMedia(manifest) {
    this.media = manifest;
    this.emit('media', manifest);
    return Promise.resolve({ payload: { mediaId: manifest?.mediaId ?? null } });
  }
  announceChunk(mediaId, chunkIndex) { this.announcedChunks.push({ mediaId, chunkIndex }); }
  queryChunk(mediaId, chunkIndex) {
    return Promise.resolve({ payload: { mediaId, chunkIndex, holderIds: [] } });
  }
  syncClock() {
    return Promise.resolve({ clientSentAt: 1000, trackerReceivedAt: 1000,
      trackerSentAt: 1000, clientReceivedAt: 1000 });
  }
  setPlayback(update) {
    this.playbackUpdates.push(update);
    this.playbackState = { ...update, effectiveAt: 2000 };
    this.emit('playback', this.playbackState);
  }
  disconnect() { this.disconnected = true; this.emit('close', {}); }
}

function setup(codes = ['ABCDEFGH'], configure = () => {}) {
  const clients = [];
  const controller = new RoomController(
    () => {
      const client = new FakeTracker();
      configure(client, clients.length);
      clients.push(client);
      return client;
    },
    () => codes.shift(),
  );
  return { controller, clients };
}

test('room codes are normalized, displayed, and restricted to readable characters', () => {
  assert.equal(generateRoomCode(() => Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])), 'ABCDEFGH');
  assert.equal(normalizeRoomCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeRoomCode(' abcd efgh '), 'ABCDEFGH');
  assert.equal(normalizeRoomCode('abcd-efg0'), null);
  assert.equal(normalizeRoomCode('abcd-efg'), null);
  assert.equal(displayRoomCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('host creates a room and leaving closes its connection', async () => {
  const { controller, clients } = setup();
  await controller.createRoom();
  assert.deepEqual(clients[0].created, ['ABCDEFGH']);
  assert.deepEqual(controller.current, {
    screen: 'room', role: 'host', code: 'ABCDEFGH', connection: 'connected',
  });
  controller.leave();
  assert.equal(clients[0].disconnected, true);
  assert.deepEqual(controller.current, { screen: 'home' });
});

test('host retries a generated code collision on the same connection', async () => {
  const created = [];
  const { controller, clients } = setup(['ABCDEFGH', 'JKMNPQRS'], (client) => {
    client.createResult = async (code) => {
      created.push(code);
      if (created.length === 1) throw new TrackerRequestError('SESSION_ALREADY_EXISTS', 'Exists');
    };
  });
  await controller.createRoom();
  assert.deepEqual(created, ['ABCDEFGH', 'JKMNPQRS']);
  assert.equal(controller.current.code, 'JKMNPQRS');
  assert.equal(clients.length, 1);
  controller.leave();
});

test('viewer validates the code and maps missing-room errors', async () => {
  const { controller, clients } = setup(['ABCDEFGH'], (client) => {
    client.joinResult = async () => {
      throw new TrackerRequestError('SESSION_NOT_FOUND', 'Missing');
    };
  });
  await controller.joinRoom('bad');
  assert.match(controller.current.error, /eight-character/);
  assert.equal(clients.length, 0);

  await controller.joinRoom('abcd-efgh');
  assert.deepEqual(clients[0].joined, ['ABCDEFGH']);
  assert.match(controller.current.error, /No room was found/);
  assert.equal(controller.current.enteredCode, 'ABCDEFGH');
});

test('viewer can retry a lost connection, while a host connection loss preserves the room view', async () => {
  const { controller, clients } = setup();
  await controller.joinRoom('ABCDEFGH');
  clients[0].emit('close', {});
  assert.equal(controller.current.connection, 'disconnected');
  await controller.retry();
  assert.equal(clients.length, 2);
  assert.equal(controller.current.connection, 'connected');
  controller.leave();

  await controller.createRoom();
  clients[2].emit('close', {});
  assert.equal(controller.current.screen, 'room');
  assert.equal(controller.current.connection, 'disconnected');
});

test('restores host and viewer room identities after refresh', async () => {
  const values = new Map();
  const store = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const clients = [];
  const factory = () => {
    const client = new FakeTracker();
    client.resumed = [];
    client.resumeHost = async (code, token) => { client.resumed.push({ code, token }); };
    clients.push(client);
    return client;
  };
  const host = new RoomController(factory, () => 'ABCDEFGH', store);
  await host.createRoom();
  const refreshedHost = new RoomController(factory, () => 'ABCDEFGH', store);
  await refreshedHost.restoreSession();
  assert.deepEqual(clients[1].resumed, [{ code: 'ABCDEFGH', token: 'test-resume-token' }]);
  assert.equal(refreshedHost.current.screen, 'room');
  assert.equal(refreshedHost.hostWasResumed, true);
  refreshedHost.leave();
  host.leave();
  assert.equal(values.size, 0);

  const viewer = new RoomController(factory, () => 'ABCDEFGH', store);
  await viewer.joinRoom('ABCDEFGH');
  const refreshedViewer = new RoomController(factory, () => 'ABCDEFGH', store);
  await refreshedViewer.restoreSession();
  assert.deepEqual(clients.at(-1).joined, ['ABCDEFGH']);
  refreshedViewer.leave();
  viewer.leave();
  assert.equal(values.size, 0);
});

test('room closure ends a viewer session and a cancelled request cannot reopen it', async () => {
  let finishConnect;
  const pending = new Promise((resolve) => { finishConnect = resolve; });
  const { controller, clients } = setup(['ABCDEFGH'], (client, index) => {
    if (index === 1) client.connectResult = pending;
  });
  await controller.joinRoom('ABCDEFGH');
  clients[0].emit('roomClosed', { reason: 'HOST_DISCONNECTED' });
  assert.equal(controller.current.screen, 'ended');
  assert.equal(clients[0].disconnected, true);

  const next = controller.joinRoom('ABCDEFGH');
  controller.leave();
  finishConnect();
  await next;
  assert.deepEqual(controller.current, { screen: 'home' });
});

test('host playback keeps a revision for play and pause, and advances it for each seek or source', () => {
  const playback = new HostPlaybackPublisher();
  const paused = { paused: true, currentTime: 0, playbackRate: 1 };
  assert.equal(playback.playbackChanged(paused), null);
  playback.sourceSelected();
  assert.deepEqual(playback.sourceReady(paused), {
    playing: false, mediaTime: 0, playbackRate: 1, revision: 1,
  });
  assert.equal(playback.sourceReady(paused)?.revision, 1);
  assert.deepEqual(playback.playbackChanged({ ...paused, paused: false }), {
    playing: true, mediaTime: 0, playbackRate: 1, revision: 1,
  });
  assert.deepEqual(playback.seeked({ ...paused, currentTime: 40 }), {
    playing: false, mediaTime: 40, playbackRate: 1, revision: 2,
  });
  playback.sourceSelected();
  assert.equal(playback.playbackChanged(paused), null);
  assert.equal(playback.sourceReady({ ...paused, currentTime: NaN }), null);
  assert.equal(playback.sourceReady(paused)?.revision, 3);
});

test('host playback continues above the tracker revision after restoring media', () => {
  const publisher = new HostPlaybackPublisher();
  publisher.seedRevision(7);
  assert.equal(publisher.sourceReady({ paused: true, currentTime: 18, playbackRate: 1 }).revision, 8);
});

test('host publishes playback through the tracker and viewer receives its state', async () => {
  const host = setup();
  await host.controller.createRoom();
  const update = { playing: true, mediaTime: 12, playbackRate: 1, revision: 1 };
  assert.equal(host.controller.publishPlayback(update), true);
  assert.deepEqual(host.clients[0].playbackUpdates, [update]);
  assert.deepEqual(host.controller.currentPlayback, { ...update, effectiveAt: 2000 });
  host.controller.leave();
  assert.equal(host.controller.publishPlayback(update), false);

  const viewer = setup();
  await viewer.controller.joinRoom('ABCDEFGH');
  await Promise.resolve();
  assert.equal(viewer.controller.currentPlayback?.revision, 0);
  viewer.clients[0].emit('playback', { ...update, effectiveAt: 2000 });
  assert.equal(viewer.controller.currentPlayback?.mediaTime, 12);
  viewer.controller.leave();
  assert.equal(viewer.controller.currentPlayback, null);
});

test('room controller shares host media and resets it when the room ends', async () => {
  const host = setup();
  await host.controller.createRoom();
  const manifest = {
    mediaId: 'media-1', durationSec: 2,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0, byteLength: 10, sha256: '0'.repeat(64) },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 2, byteLength: 100, sha256: '1'.repeat(64) },
    ],
  };
  await host.controller.publishMedia(manifest);
  assert.deepEqual(host.controller.currentMedia, manifest);
  assert.deepEqual(host.clients[0].announcedChunks, [
    { mediaId: 'media-1', chunkIndex: 0 }, { mediaId: 'media-1', chunkIndex: 1 },
  ]);
  await host.controller.publishMedia(null);
  assert.equal(host.controller.currentMedia, null);
  host.controller.leave();
  await assert.rejects(host.controller.publishMedia(manifest), /Only the room host/);

  const viewer = setup();
  await viewer.controller.joinRoom('ABCDEFGH');
  viewer.clients[0].emit('media', manifest);
  assert.deepEqual(viewer.controller.currentMedia, manifest);
  viewer.controller.leave();
  assert.equal(viewer.controller.currentMedia, null);
});

test('viewer accepts a new metadata window for the same video', async () => {
  const { controller, clients } = setup();
  await controller.joinRoom('ABCDEFGH');
  const first = {
    mediaId: 'media-1', durationSec: 20, totalChunks: 4,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0,
        byteLength: 1, sha256: '0'.repeat(64) },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 10,
        byteLength: 1, sha256: '1'.repeat(64) },
    ],
  };
  const updates = [];
  controller.subscribeMedia((manifest) => updates.push(manifest));
  clients[0].emit('media', first);
  const second = { ...first, chunks: [first.chunks[0], {
    ...first.chunks[1], chunkIndex: 3, startTimeSec: 10, endTimeSec: 20,
  }] };
  clients[0].emit('media', second);
  assert.deepEqual(controller.currentMedia, second);
  assert.equal(updates.at(-1), second);
  assert.deepEqual(controller.currentChunkProgress, { downloaded: 0, total: 2 });
  controller.leave();
});

test('a superseded media publication does not announce old chunks', async () => {
  const { controller, clients } = setup();
  await controller.createRoom();
  const manifest = {
    mediaId: 'old-media', durationSec: 2,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0,
        byteLength: 10, sha256: '0'.repeat(64) },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 2,
        byteLength: 10, sha256: '1'.repeat(64) },
    ],
  };
  let finishOld;
  clients[0].setMedia = (value) => value
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ payload: { mediaId: null } });
  const oldPublication = controller.publishMedia(manifest);
  await controller.publishMedia(null);
  finishOld({ payload: { mediaId: 'old-media' } });
  await oldPublication;
  assert.deepEqual(clients[0].announcedChunks, []);
  controller.leave();
});
