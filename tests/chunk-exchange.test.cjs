const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DataOpcode,
  encodeDataMessage,
  decodeDataMessage,
} = require('../packages/protocol/index.ts');
const { ChunkExchange } = require('../apps/web/src/chunk-exchange.ts');

test('fragment codec preserves ranges and rejects an invalid fragment', () => {
  const fragment = {
    opcode: DataOpcode.FRAGMENT,
    requestId: 7,
    chunkIndex: 3,
    totalBytes: 100,
    offset: 20,
    data: Uint8Array.of(1, 2, 3),
  };
  assert.deepEqual(decodeDataMessage(encodeDataMessage(fragment)), fragment);
  assert.throws(() => encodeDataMessage({ ...fragment, offset: 99 }), /range/);
  const malformed = encodeDataMessage(fragment);
  new DataView(malformed.buffer).setUint32(13, 99, false);
  assert.throws(() => decodeDataMessage(malformed), /range/);
});

test('serves a large chunk in bounded packets and reassembles it for the requester', async () => {
  const chunk = Uint8Array.from({ length: 40_000 }, (_, index) => index % 251);
  const packets = [];
  const results = [];
  const fragments = [];
  let host;
  let viewer;
  host = new ChunkExchange({
    readChunk: (index) => index === 4 ? chunk : null,
    send: async (_peerId, packet) => {
      packets.push(packet);
      await viewer.receive('host', packet);
    },
    onResult: () => assert.fail('Host must not receive its own response'),
  });
  viewer = new ChunkExchange({
    readChunk: () => null,
    send: (_peerId, packet) => host.receive('viewer', packet),
    onResult: (peerId, result) => results.push({ peerId, result }),
    onFragment: (peerId, chunkIndex, requestId) =>
      fragments.push({ peerId, chunkIndex, requestId }),
  });

  await viewer.request('host', 4, 7);
  assert.ok(packets.length > 1);
  assert.ok(packets.every((packet) => packet.byteLength <= 16 * 1024));
  assert.equal(fragments.length, packets.length);
  assert.ok(fragments.every(({ peerId, chunkIndex, requestId }) =>
    peerId === 'host' && chunkIndex === 4 && requestId === 7));
  assert.deepEqual(results, [{
    peerId: 'host',
    result: { opcode: DataOpcode.PAYLOAD, requestId: 7, chunkIndex: 4, data: chunk },
  }]);

  await viewer.request('host', 5, 8);
  assert.deepEqual(results[1], {
    peerId: 'host',
    result: { opcode: DataOpcode.NOT_AVAILABLE, requestId: 8, chunkIndex: 5 },
  });
  host.close();
  viewer.close();
});

test('rejects out-of-order fragments without delivering a partial chunk', async () => {
  const errors = [];
  const results = [];
  const exchange = new ChunkExchange({
    readChunk: () => null,
    send: async () => {},
    onResult: (_peerId, result) => results.push(result),
    onError: (error) => errors.push(error.message),
  });
  const base = {
    opcode: DataOpcode.FRAGMENT,
    requestId: 9,
    chunkIndex: 2,
    totalBytes: 10,
  };
  await exchange.receive('peer', encodeDataMessage({
    ...base, offset: 0, data: Uint8Array.of(1, 2),
  }));
  await exchange.receive('peer', encodeDataMessage({
    ...base, offset: 4, data: Uint8Array.of(3, 4),
  }));
  assert.equal(results.length, 0);
  assert.match(errors[0], /out of order/);
  exchange.close();
  await assert.rejects(exchange.request('peer', 2, 10), /closed/);
});
