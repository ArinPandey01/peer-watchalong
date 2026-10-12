const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackerRequestError } = require('../packages/tracker-client/src/tracker-client.ts');
const { RoomController } = require('../apps/web/src/room-controller.ts');
const {
  generateRoomCode,
  normalizeRoomCode,
  displayRoomCode,
} = require('../apps/web/src/room-code.ts');

class FakeTracker {
  listeners = new Map();
  created = [];
  joined = [];
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
  async createRoom(code) { this.created.push(code); await this.createResult(code); }
  async joinRoom(code) { this.joined.push(code); await this.joinResult(code); }
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

test('viewer can retry a lost connection, while a host connection loss ends the room', async () => {
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
  assert.equal(controller.current.screen, 'ended');
  assert.match(controller.current.reason, /room has ended/);
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
