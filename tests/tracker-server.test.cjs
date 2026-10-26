const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { TrackerControlHandler } = require('../apps/tracker/src/control-handler.ts');
const { RoomRegistry } = require('../apps/tracker/src/room-registry.ts');
const { startTrackerServer } = require('../apps/tracker/src/server.ts');

const trackerRequire = createRequire(require.resolve('../apps/tracker/package.json'));
const WebSocket = trackerRequire('ws');
const quietLogger = { info() {}, error() {} };

function controlMessage(type, payload, senderId, messageId) {
  return {
    version: 1, type, messageId, sessionId: 'room', timestamp: 1000,
    ...(senderId ? { senderId } : {}), payload,
  };
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  return socket;
}

function waitForMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), 2000);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === type) finish(null, message);
    };
    const onClose = () => finish(new Error(`Socket closed before ${type}`));
    const finish = (error, message) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(message);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for tracker state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('routes room, chunk, and host-disconnect messages over real WebSockets', async (t) => {
  let peerNumber = 0;
  const registry = new RoomRegistry({ createPeerId: () => `peer-${++peerNumber}` });
  const handler = new TrackerControlHandler({ registry });
  const tracker = await startTrackerServer({
    port: 0, host: '127.0.0.1', handler, logger: quietLogger,
  });
  const port = tracker.server.address().port;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await tracker.close();
  });

  const host = await connect(port);
  clients.push(host);
  const createReply = waitForMessage(host, 'CREATE_ROOM_RES');
  host.send(JSON.stringify(controlMessage('CREATE_ROOM_REQ', {}, null, 'create')));
  const hostId = (await createReply).payload.assignedPeerId;

  const viewer = await connect(port);
  clients.push(viewer);
  const joinReply = waitForMessage(viewer, 'JOIN_ROOM_RES');
  viewer.send(JSON.stringify(controlMessage('JOIN_ROOM_REQ', {}, null, 'join')));
  const viewerId = (await joinReply).payload.assignedPeerId;

  const manifest = {
    mediaId: 'media-1', durationSec: 2,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: [
      { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0, byteLength: 10, sha256: '0'.repeat(64) },
      { chunkIndex: 1, trackId: 1, kind: 'media', startTimeSec: 0, endTimeSec: 1, byteLength: 10, sha256: '1'.repeat(64) },
      { chunkIndex: 2, trackId: 1, kind: 'media', startTimeSec: 1, endTimeSec: 2, byteLength: 10, sha256: '2'.repeat(64) },
    ],
  };
  const mediaReply = waitForMessage(host, 'MEDIA_SET_RES');
  host.send(JSON.stringify(controlMessage('MEDIA_SET_REQ', { manifest }, hostId, 'media')));
  await mediaReply;
  host.send(JSON.stringify(controlMessage('CHUNK_HAVE_EVENT',
    { mediaId: 'media-1', chunkIndex: 2 }, hostId, 'have')));
  await waitUntil(() => registry.getEligibleChunkHolders('room', viewerId, 'media-1', 2).includes(hostId));
  const queryReply = waitForMessage(viewer, 'CHUNK_QUERY_RES');
  viewer.send(JSON.stringify(controlMessage('CHUNK_QUERY_REQ',
    { mediaId: 'media-1', chunkIndex: 2 }, viewerId, 'query')));
  assert.deepEqual((await queryReply).payload.holderIds, [hostId]);

  const roomClosed = waitForMessage(viewer, 'ROOM_CLOSED_EVENT');
  const viewerClose = once(viewer, 'close');
  host.close(1000, 'Leave room');
  assert.equal((await roomClosed).payload.reason, 'HOST_DISCONNECTED');
  await viewerClose;
});

test('keeps viewers connected while the host refreshes and resumes', async (t) => {
  const tracker = await startTrackerServer({
    port: 0, host: '127.0.0.1', hostResumeGraceMs: 500,
    logger: quietLogger,
  });
  const port = tracker.server.address().port;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await tracker.close();
  });

  const host = await connect(port);
  clients.push(host);
  const created = waitForMessage(host, 'CREATE_ROOM_RES');
  host.send(JSON.stringify(controlMessage('CREATE_ROOM_REQ', {}, null, 'create')));
  const { resumeToken, assignedPeerId } = (await created).payload;
  const viewer = await connect(port);
  clients.push(viewer);
  const joined = waitForMessage(viewer, 'JOIN_ROOM_RES');
  viewer.send(JSON.stringify(controlMessage('JOIN_ROOM_REQ', {}, null, 'join')));
  await joined;

  host.close();
  await once(host, 'close');
  const resumedHost = await connect(port);
  clients.push(resumedHost);
  const resumed = waitForMessage(resumedHost, 'RESUME_HOST_RES');
  const reconnected = waitForMessage(viewer, 'HOST_RECONNECTED_EVENT');
  resumedHost.send(JSON.stringify(controlMessage('RESUME_HOST_REQ', { resumeToken }, null, 'resume')));
  assert.equal((await resumed).payload.assignedPeerId, assignedPeerId);
  assert.equal((await reconnected).payload.hostPeerId, assignedPeerId);
  assert.equal(viewer.readyState, viewer.OPEN);
});

test('reports a bind failure to its caller', async () => {
  const first = await startTrackerServer({ port: 0, host: '127.0.0.1', logger: quietLogger });
  try {
    const port = first.server.address().port;
    await assert.rejects(
      startTrackerServer({ port, host: '127.0.0.1', logger: quietLogger }),
      (error) => error.code === 'EADDRINUSE',
    );
  } finally {
    await first.close();
  }
});

test('terminates a client that does not complete the shutdown handshake', async () => {
  const tracker = await startTrackerServer({
    port: 0, host: '127.0.0.1', closeGraceMs: 25, logger: quietLogger,
  });
  const client = await connect(tracker.server.address().port);
  const serverSocket = [...tracker.server.clients][0];
  serverSocket.close = () => {};
  const serverClosed = once(serverSocket, 'close');
  try {
    await tracker.close();
    await serverClosed;
    assert.equal(serverSocket.readyState, WebSocket.CLOSED);
    await tracker.close();
  } finally {
    client.terminate();
  }
});
