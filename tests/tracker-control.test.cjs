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
  handler.handle('host', request('CHUNK_HAVE_EVENT', host, { chunkIndex: 4 }));
  const response = handler.handle('viewer', request('CHUNK_QUERY_REQ', viewer, {
    chunkIndex: 4,
  }, 'query-4'))[0].message;
  assert.equal(response.type, 'CHUNK_QUERY_RES');
  assert.equal(response.replyTo, 'query-4');
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
