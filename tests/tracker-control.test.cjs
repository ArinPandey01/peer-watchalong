const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackerControlHandler } = require('../apps/tracker/src/control-handler.ts');
const { RoomRegistry } = require('../apps/tracker/src/room-registry.ts');
const { validateControlMessage } = require('../packages/protocol/control-validator.ts');

function setup() {
  let now = 1000;
  let peerNumber = 0;
  let messageNumber = 0;
  const registry = new RoomRegistry({
    createPeerId: () => `peer-${++peerNumber}`,
    now: () => now,
  });
  const handler = new TrackerControlHandler({
    registry,
    createMessageId: () => `out-${++messageNumber}`,
    now: () => now,
  });
  const request = (type, senderId, payload, messageId = 'request') => ({
    version: 1, type, messageId, sessionId: 'room', timestamp: now,
    ...(senderId ? { senderId } : {}), payload,
  });
  const create = () => handler.handle('host', request('CREATE_ROOM_REQ', null, {}))[0].message;
  const join = (connectionId) => handler.handle(connectionId, request('JOIN_ROOM_REQ', null, {}))[0].message;
  return { handler, registry, request, create, join, setNow: (value) => { now = value; } };
}

function manifest(mediaId = 'media-1') {
  return {
    mediaId,
    durationSec: 4,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0, byteLength: 50, sha256: '0'.repeat(64) },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 4, byteLength: 100, sha256: '1'.repeat(64) },
    ],
  };
}

test('only host sets media, late viewers retrieve it, and replacement clears old claims', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  const viewer = join('viewer').payload.assignedPeerId;
  const first = manifest();
  const denied = handler.handle('viewer', request('MEDIA_SET_REQ', viewer, { manifest: first }));
  assert.equal(denied[0].message.payload.code, 'NOT_HOST');

  const published = handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: first }));
  assert.equal(published[0].message.type, 'MEDIA_SET_RES');
  assert.equal(published[0].message.payload.mediaId, 'media-1');
  assert.equal(published.filter(({ message }) => message.type === 'MEDIA_EVENT').length, 2);
  for (const outbound of published) assert.doesNotThrow(() => validateControlMessage(outbound.message));
  const late = join('late').payload.assignedPeerId;
  const fetched = handler.handle('late', request('MEDIA_GET_REQ', late, {}))[0].message;
  assert.deepEqual(fetched.payload.manifest, first);

  handler.handle('host', request('CHUNK_HAVE_EVENT', host,
    { mediaId: 'media-1', chunkIndex: 1 }));
  const holdersBefore = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer,
    { mediaId: 'media-1', chunkIndex: 1 }))[0].message.payload.holderIds;
  assert.deepEqual(holdersBefore, [host]);
  handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: manifest('media-2') }));
  const staleQuery = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer,
    { mediaId: 'media-1', chunkIndex: 1 }))[0].message;
  assert.equal(staleQuery.payload.code, 'INVALID_CHUNK');
  const staleClaim = handler.handle('host', request('CHUNK_HAVE_EVENT', host,
    { mediaId: 'media-1', chunkIndex: 1 }))[0].message;
  assert.equal(staleClaim.payload.code, 'INVALID_CHUNK');
  const holdersAfter = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer,
    { mediaId: 'media-2', chunkIndex: 1 }))[0].message.payload.holderIds;
  assert.deepEqual(holdersAfter, []);
  handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: null }));
  assert.equal(handler.handle('late', request('MEDIA_GET_REQ', late, {}))[0]
    .message.payload.manifest, null);
});

test('window updates keep stable chunk claims and reject expired indices', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  const viewer = join('viewer').payload.assignedPeerId;
  const base = manifest();
  base.totalChunks = 4;
  base.chunks.push({ ...base.chunks[1], chunkIndex: 2, startTimeSec: 1,
    endTimeSec: 2, sha256: '2'.repeat(64) });
  base.chunks[1].endTimeSec = 1;
  handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: base }));
  handler.handle('host', request('CHUNK_HAVE_EVENT', host,
    { mediaId: 'media-1', chunkIndex: 2 }));

  const next = structuredClone(base);
  next.chunks = [next.chunks[0], next.chunks[2], {
    ...next.chunks[2], chunkIndex: 3, startTimeSec: 2, endTimeSec: 4,
    sha256: '3'.repeat(64),
  }];
  const updated = handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: next }));
  assert.equal(updated[0].message.type, 'MEDIA_SET_RES');
  const holders = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer,
    { mediaId: 'media-1', chunkIndex: 2 }));
  assert.deepEqual(holders[0].message.payload.holderIds, [host]);
  const old = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer,
    { mediaId: 'media-1', chunkIndex: 1 }));
  assert.equal(old[0].message.payload.code, 'INVALID_CHUNK');
});

test('rejects malformed media metadata before it reaches the room', () => {
  const { handler, request, create } = setup();
  const host = create().payload.assignedPeerId;
  const bad = manifest();
  bad.chunks[1].chunkIndex = 7;
  assert.equal(handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: bad }))[0]
    .message.payload.code, 'INVALID_MESSAGE');
  const another = manifest();
  another.tracks[0].mimeType = 'text/html';
  assert.equal(handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: another }))[0]
    .message.payload.code, 'INVALID_MESSAGE');
});

test('binds connections and rejects spoofed playback or signaling', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  const viewer = join('viewer').payload.assignedPeerId;
  const update = { playing: true, mediaTime: 0, playbackRate: 1, revision: 0 };

  assert.equal(handler.handle('viewer', request('PLAYBACK_SET_REQ', viewer, update))[0]
    .message.payload.code, 'NOT_HOST');
  assert.equal(handler.handle('viewer', request('PLAYBACK_SET_REQ', host, update))[0]
    .message.payload.code, 'NOT_REGISTERED');
  assert.equal(handler.handle('viewer', request('SIGNAL_SDP', host, {
    targetPeerId: viewer, description: { type: 'offer', sdp: 'sdp' },
  }))[0].message.payload.code, 'NOT_REGISTERED');
  assert.equal(handler.handle('host', request('PLAYBACK_SET_REQ', host, update))
    .filter(({ message }) => message.type === 'PLAYBACK_STATE_EVENT').length, 2);
});

test('answers holder queries only with authorized peers that claim the chunk', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  const viewer = join('viewer').payload.assignedPeerId;
  handler.handle('host', request('MEDIA_SET_REQ', host, { manifest: manifest() }));
  handler.handle('host', request('CHUNK_HAVE_EVENT', host,
    { mediaId: 'media-1', chunkIndex: 1 }));
  const response = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer, {
    mediaId: 'media-1', chunkIndex: 1,
  }, 'query-1'))[0].message;
  assert.equal(response.type, 'CHUNK_QUERY_RES');
  assert.equal(response.replyTo, 'query-1');
  assert.deepEqual(response.payload.holderIds, [host]);
});

test('rejects signaling to a peer outside the authorized topology', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  join('viewer-1');
  join('viewer-2');
  join('viewer-3');
  const distantViewer = join('viewer-4').payload.assignedPeerId;
  const response = handler.handle('host', request('SIGNAL_SDP', host, {
    targetPeerId: distantViewer,
    description: { type: 'offer', sdp: 'sdp' },
  }))[0].message;
  assert.equal(response.payload.code, 'NOT_NEIGHBOR');
});

test('rejects malformed client messages and an attempted second registration', () => {
  const { handler, request, create } = setup();
  create();
  assert.equal(handler.handle('host', '{bad json')[0].message.payload.code,
    'INVALID_MESSAGE');
  assert.equal(handler.handle('host', request('CREATE_ROOM_REQ', null, {}))[0]
    .message.payload.code, 'INVALID_MESSAGE');
});

test('returns tracker clock timestamps and correlates the reply', () => {
  const { handler, request, create, setNow } = setup();
  const host = create().payload.assignedPeerId;
  setNow(1050);
  const response = handler.handle('host', request('CLOCK_SYNC_REQ', host, {
    clientSentAt: 1000,
  }, 'clock-1'))[0].message;
  assert.equal(response.type, 'CLOCK_SYNC_RES');
  assert.equal(response.replyTo, 'clock-1');
  assert.deepEqual(response.payload, {
    clientSentAt: 1000, trackerReceivedAt: 1050, trackerSentAt: 1050,
  });
});

test('preserves revision for play/pause and advances it once for a host seek', () => {
  const { handler, request, create, join } = setup();
  const host = create().payload.assignedPeerId;
  join('viewer');
  const play = handler.handle('host', request('PLAYBACK_SET_REQ', host, {
    playing: true, mediaTime: 0, playbackRate: 1, revision: 0,
  }));
  assert.equal(play[0].message.payload.state.revision, 0);

  const seek = handler.handle('host', request('PLAYBACK_SET_REQ', host, {
    playing: true, mediaTime: 20, playbackRate: 1, revision: 1,
  }));
  assert.equal(seek[0].message.payload.state.mediaTime, 20);
  assert.equal(seek[0].message.payload.state.revision, 1);

  const skipped = handler.handle('host', request('PLAYBACK_SET_REQ', host, {
    playing: true, mediaTime: 30, playbackRate: 1, revision: 3,
  }));
  assert.equal(skipped[0].message.payload.code, 'INVALID_PLAYBACK_STATE');

  const stale = handler.handle('host', request('PLAYBACK_SET_REQ', host, {
    playing: true, mediaTime: 0, playbackRate: 1, revision: 0,
  }));
  assert.equal(stale[0].message.payload.code, 'STALE_PLAYBACK_REVISION');
});

test('notifies viewers when the host leaves and clears their bindings', () => {
  const { handler, create, join } = setup();
  create();
  join('viewer');
  const notices = handler.disconnect('host');
  assert.deepEqual(notices.map(({ connectionId }) => connectionId), ['viewer']);
  assert.equal(notices[0].message.type, 'ROOM_CLOSED_EVENT');
  assert.equal(notices[0].message.payload.reason, 'HOST_DISCONNECTED');
  assert.doesNotThrow(() => validateControlMessage(notices[0].message));
  assert.equal(handler.getBinding('viewer'), undefined);
  assert.deepEqual(handler.disconnect('viewer'), []);
});

test('temporarily suspends a disconnected host and only resumes with its token', () => {
  const { handler, registry, request, create, join, setNow } = setup();
  const created = create();
  const hostId = created.payload.assignedPeerId;
  const viewerId = join('viewer').payload.assignedPeerId;
  assert.equal(typeof created.payload.resumeToken, 'string');
  const playback = handler.handle('host', request('PLAYBACK_SET_REQ', hostId, {
    playing: true, mediaTime: 12, playbackRate: 1, revision: 1,
  }));
  assert.equal(playback.some(({ message }) => message.type === 'PLAYBACK_STATE_EVENT'), true);

  setNow(6000);
  const paused = handler.disconnect('host', true);
  assert.equal(handler.isHostSuspended('room'), true);
  assert.equal(registry.getRoom('room').playback.playing, false);
  assert.equal(registry.getRoom('room').playback.mediaTime, 17);
  assert.equal(paused[0].message.type, 'PLAYBACK_STATE_EVENT');
  const denied = handler.handle('impostor', request('RESUME_HOST_REQ', null, { resumeToken: 'wrong' }));
  assert.equal(denied[0].message.payload.code, 'INVALID_RESUME_TOKEN');
  assert.equal(handler.getBinding('impostor'), undefined);

  const resumed = handler.handle('new-host', request('RESUME_HOST_REQ', null, {
    resumeToken: created.payload.resumeToken,
  }));
  assert.equal(resumed[0].message.type, 'RESUME_HOST_RES');
  assert.equal(resumed[0].message.payload.assignedPeerId, hostId);
  assert.equal(resumed.some(({ connectionId, message }) =>
    connectionId === 'viewer' && message.type === 'HOST_RECONNECTED_EVENT'), true);
  assert.deepEqual(handler.getBinding('new-host'), { sessionId: 'room', peerId: hostId });
  assert.equal(handler.isHostSuspended('room'), false);
  assert.equal(handler.getBinding('viewer').peerId, viewerId);
  assert.deepEqual(handler.expireSuspendedHost('room'), []);
  assert.ok(registry.getRoom('room'));
});

test('expires an unresumed host and closes viewer bindings', () => {
  const { handler, registry, create, join } = setup();
  create();
  join('viewer');
  handler.disconnect('host', true);
  const notices = handler.expireSuspendedHost('room');
  assert.equal(notices[0].message.type, 'ROOM_CLOSED_EVENT');
  assert.equal(registry.getRoom('room'), undefined);
  assert.equal(handler.getBinding('viewer'), undefined);
});
