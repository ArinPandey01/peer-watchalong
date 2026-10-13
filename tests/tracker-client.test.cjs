const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackerClient } = require('../packages/tracker-client/src/tracker-client.ts');

class FakeSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  sent = [];

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }

  error() {
    this.onerror?.({});
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function createClient(options = {}) {
  const sockets = [];
  let nextId = 0;
  const client = new TrackerClient('ws://tracker', {
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    createMessageId: () => `message-${++nextId}`,
    now: () => 1000,
    connectionTimeoutMs: 20,
    ...options,
  });
  return { client, sockets };
}

function serverMessage(type, payload, extra = {}) {
  return {
    version: 1,
    type,
    messageId: 'server-message',
    sessionId: 'room',
    timestamp: 1000,
    payload,
    ...extra,
  };
}

async function register(client, socket) {
  const registration = client.joinRoom('room');
  const request = socket.sent.at(-1);
  socket.receive(serverMessage('JOIN_ROOM_RES', {
    assignedPeerId: 'viewer',
    hostPeerId: 'host',
    topology: { layer: 1, parents: ['host'], children: [], siblings: [] },
  }, { replyTo: request.messageId }));
  await registration;
}

test('a close during the handshake rejects connect and allows retry', async () => {
  const { client, sockets } = createClient();
  const first = client.connect();
  assert.strictEqual(client.connect(), first);
  sockets[0].close(1006, 'Connection lost');
  await assert.rejects(first, /closed before opening/);

  const second = client.connect();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await second;
  assert.equal(client.connected, true);
  client.disconnect();
});

test('a connection error closes the old socket without affecting a retry', async () => {
  const { client, sockets } = createClient();
  const first = client.connect();
  sockets[0].error();
  await assert.rejects(first, /Unable to connect/);
  assert.equal(sockets[0].readyState, 3);

  const second = client.connect();
  sockets[1].open();
  await second;
  sockets[0].onclose({ code: 1006, reason: 'late close', wasClean: false });
  assert.equal(client.connected, true);
  await register(client, sockets[1]);
  sockets[0].receive(serverMessage('ROOM_CLOSED_EVENT', {
    reason: 'HOST_DISCONNECTED',
  }));
  assert.deepEqual(client.identity, { sessionId: 'room', peerId: 'viewer' });
  client.disconnect();
});

test('a connection timeout rejects connect and allows retry', async () => {
  const { client, sockets } = createClient();
  await assert.rejects(client.connect(), /timed out/);
  assert.equal(sockets[0].readyState, 3);
  const retry = client.connect();
  sockets[1].open();
  await retry;
  client.disconnect();
});

test('a socket factory failure does not retain a rejected connection', async () => {
  let attempts = 0;
  const { client, sockets } = createClient({
    createWebSocket: () => {
      if (++attempts === 1) throw new Error('Factory failed');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await assert.rejects(client.connect(), /Factory failed/);
  const retry = client.connect();
  sockets[0].open();
  await retry;
  client.disconnect();
});

test('room closure clears identity, rejects room requests, and reports the reason', async () => {
  const { client, sockets } = createClient();
  const opening = client.connect();
  sockets[0].open();
  await opening;
  await register(client, sockets[0]);

  const closed = [];
  client.on('roomClosed', (event) => closed.push(event));
  const query = client.queryChunk('media-1', 4);
  sockets[0].receive(serverMessage('ROOM_CLOSED_EVENT', {
    reason: 'HOST_DISCONNECTED',
  }));

  await assert.rejects(query, /room closed/);
  assert.deepEqual(closed, [{ reason: 'HOST_DISCONNECTED' }]);
  assert.equal(client.identity, null);
  assert.throws(() => client.queryChunk('media-1', 4), /not registered/);
  client.disconnect();
});
