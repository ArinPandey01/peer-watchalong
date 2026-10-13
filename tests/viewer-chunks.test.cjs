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
