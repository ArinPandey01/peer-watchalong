const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DataOpcode } = require('../packages/protocol/data.ts');
const { ViewerChunkLoader } = require('../apps/web/src/viewer-chunks.ts');

function manifestFor(chunks) {
  return {
    mediaId: 'media-1', durationSec: 20,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: chunks.map((data, chunkIndex) => ({
      chunkIndex, trackId: 1, kind: chunkIndex === 0 ? 'init' : 'media',
      startTimeSec: chunkIndex === 0 ? 0 : (chunkIndex - 1) * 10,
      endTimeSec: chunkIndex === 0 ? 0 : chunkIndex * 10,
      byteLength: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
}

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('downloads, verifies, caches, and announces a chunk', async () => {
  const source = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])];
  const queried = [];
  const requested = [];
  const announced = [];
  const progress = [];
  const loader = new ViewerChunkLoader({
    manifest: manifestFor(source),
    queryHolders: async (chunkIndex) => { queried.push(chunkIndex); return ['host']; },
    requestChunk: async (peerId, chunkIndex, requestId) => {
      requested.push({ peerId, chunkIndex, requestId });
    },
    announceChunk: (chunkIndex) => announced.push(chunkIndex),
    onProgress: (downloaded, total) => progress.push([downloaded, total]),
    now: () => 1000,
  });
  loader.updateTarget(0, 0);
  await drain();
  assert.deepEqual(queried, [0, 1]);
  assert.equal(requested.length, 2);
  const initRequest = requested.find((request) => request.chunkIndex === 0);
  await loader.receive('host', {
    opcode: DataOpcode.PAYLOAD, requestId: initRequest.requestId,
    chunkIndex: 0, data: source[0],
  });
  assert.deepEqual(loader.readChunk(0), source[0]);
  assert.deepEqual(announced, [0]);
  assert.deepEqual(progress.at(-1), [1, 2]);
  loader.close();
});

test('rejects altered bytes and ignores data after closing', async () => {
  const source = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])];
  const requested = [];
  const announced = [];
  const loader = new ViewerChunkLoader({
    manifest: manifestFor(source),
    queryHolders: async () => ['host'],
    requestChunk: async (peerId, chunkIndex, requestId) => {
      requested.push({ peerId, chunkIndex, requestId });
    },
    announceChunk: (chunkIndex) => announced.push(chunkIndex),
    now: () => 1000,
  });
  loader.updateTarget(0, 0);
  await drain();
  const request = requested.find((item) => item.chunkIndex === 0);
  await loader.receive('host', {
    opcode: DataOpcode.PAYLOAD, requestId: request.requestId,
    chunkIndex: 0, data: Uint8Array.from([9, 9]),
  });
  assert.equal(loader.readChunk(0), null);
  assert.deepEqual(announced, []);
  loader.close();
  await loader.receive('host', {
    opcode: DataOpcode.PAYLOAD, requestId: request.requestId,
    chunkIndex: 0, data: source[0],
  });
  assert.equal(loader.readChunk(0), null);
  assert.deepEqual(announced, []);
});

test('drops expired cached bytes and verifies stable IDs in a new window', async () => {
  const source = [Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(2)];
  const initial = manifestFor(source);
  const requested = [];
  const progress = [];
  const loader = new ViewerChunkLoader({
    manifest: initial,
    queryHolders: async () => ['host'],
    requestChunk: async (peerId, chunkIndex, requestId) => {
      requested.push({ peerId, chunkIndex, requestId });
    },
    announceChunk: () => {},
    onProgress: (downloaded, total) => progress.push([downloaded, total]),
    now: () => 1000,
  });
  loader.updateTarget(0, 0);
  await drain();
  const first = requested.find((request) => request.chunkIndex === 1);
  await loader.receive('host', {
    opcode: DataOpcode.PAYLOAD, requestId: first.requestId,
    chunkIndex: 1, data: source[1],
  });
  assert.deepEqual(loader.readChunk(1), source[1]);

  loader.updateManifest({ ...initial, totalChunks: 3,
    chunks: [initial.chunks[0], initial.chunks[2]] });
  assert.equal(loader.readChunk(1), null);
  assert.deepEqual(progress.at(-1), [0, 2]);
  const next = requested.find((request) => request.chunkIndex === 2);
  await loader.receive('host', {
    opcode: DataOpcode.PAYLOAD, requestId: next.requestId,
    chunkIndex: 2, data: source[2],
  });
  assert.deepEqual(loader.readChunk(2), source[2]);
  loader.close();
});

test('a seek requests the preceding audio and video bundle', async () => {
  const chunks = [Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(2)];
  const manifest = {
    mediaId: 'bundled', durationSec: 20,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks: chunks.map((data, index) => ({
      chunkIndex: index,
      ...(index === 0 ? { trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0 } : {
        kind: 'media', startTimeSec: (index - 1) * 10, endTimeSec: index * 10,
        parts: [{ trackId: 1, startTimeSec: (index - 1) * 10,
          endTimeSec: index * 10, byteLength: 1 }],
      }),
      byteLength: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
  const queried = [];
  const loader = new ViewerChunkLoader({
    manifest,
    queryHolders: async (index) => { queried.push(index); return ['host']; },
    requestChunk: async () => {},
    announceChunk: () => {},
    now: () => 1000,
  });
  loader.updateTarget(15, 1);
  await drain();
  assert.ok(queried.includes(1));
  loader.close();
});
