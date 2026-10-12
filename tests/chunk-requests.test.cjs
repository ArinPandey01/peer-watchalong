const test = require('node:test');
const assert = require('node:assert/strict');
const { ChunkRequestScheduler } = require('../packages/scheduler/index.ts');
const DataOpcode = { PAYLOAD: 0x02, NOT_AVAILABLE: 0x03 };

const plan = (...indices) => indices.map((chunkIndex) => ({
  chunkIndex, priority: 'URGENT', secondsUntilNeeded: chunkIndex,
}));

test('queries the tracker, requests an eligible holder, and records a valid transfer', () => {
  const scheduler = new ChunkRequestScheduler();
  assert.deepEqual(scheduler.updatePlan(plan(0), 1, 1000), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 1 },
  ]);
  assert.deepEqual(scheduler.onHolders(0, 1, ['peer-a'], 1020), [
    { type: 'REQUEST_CHUNK', peerId: 'peer-a', chunkIndex: 0, requestId: 1 },
  ]);
  assert.deepEqual(scheduler.getPeerPerformance().get('peer-a'), {
    pendingRequests: 1,
  });
  const data = new Uint8Array(1000);
  assert.deepEqual(scheduler.onData('peer-a', {
    opcode: DataOpcode.PAYLOAD, requestId: 1, chunkIndex: 0, data,
  }, 1120, true), [
    { type: 'CHUNK_RECEIVED', peerId: 'peer-a', chunkIndex: 0, data },
  ]);
  assert.deepEqual(scheduler.getPeerPerformance().get('peer-a'), {
    pendingRequests: 0, latencyEmaMs: 100,
    throughputEmaBytesPerSec: 10000, recentFailures: 0,
  });
  scheduler.markOwned(0, 1130); 
  assert.deepEqual(scheduler.updatePlan(plan(0), 1, 1200), []);
});

test('retries another holder on NOT_AVAILABLE and ignores late or mismatched responses', () => {
  const scheduler = new ChunkRequestScheduler();
  scheduler.updatePlan(plan(2), 0, 0);
  assert.deepEqual(scheduler.onHolders(2, 1, ['a', 'b'], 10), [
    { type: 'REQUEST_CHUNK', peerId: 'a', chunkIndex: 2, requestId: 1 },
  ]);
  assert.deepEqual(scheduler.onData('b', {
    opcode: DataOpcode.NOT_AVAILABLE, requestId: 1, chunkIndex: 2,
  }, 20), []);
  assert.deepEqual(scheduler.onData('a', {
    opcode: DataOpcode.NOT_AVAILABLE, requestId: 1, chunkIndex: 2,
  }, 30), [
    { type: 'REQUEST_CHUNK', peerId: 'b', chunkIndex: 2, requestId: 2 },
  ]);
  assert.deepEqual(scheduler.onData('a', {
    opcode: DataOpcode.PAYLOAD, requestId: 1, chunkIndex: 2,
    data: new Uint8Array(10),
  }, 40, true), []);
  assert.equal(scheduler.getPeerPerformance().get('a').recentFailures, 1);
  assert.deepEqual(scheduler.onData('b', {
    opcode: DataOpcode.PAYLOAD, requestId: 2, chunkIndex: 2,
    data: new Uint8Array(10),
  }, 50, false), []);
  assert.deepEqual(scheduler.tick(549), []);
  assert.deepEqual(scheduler.tick(550), [
    { type: 'QUERY_HOLDERS', chunkIndex: 2, queryToken: 2 },
  ]);
});

test('times out requests and queries with bounded backoff', () => {
  const scheduler = new ChunkRequestScheduler({
    requestTimeoutMs: 100, queryTimeoutMs: 50,
    initialQueryBackoffMs: 20, maxQueryBackoffMs: 40,
  });
  scheduler.updatePlan(plan(0), 1, 0);
  assert.deepEqual(scheduler.tick(50), []);
  assert.deepEqual(scheduler.tick(69), []);
  assert.deepEqual(scheduler.tick(70), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 2 },
  ]);
  assert.deepEqual(scheduler.onHolders(0, 1, ['stale'], 75), []);
  assert.deepEqual(scheduler.onHolders(0, 2, [], 80), []);
  assert.deepEqual(scheduler.tick(119), []);
  assert.deepEqual(scheduler.tick(120), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 3 },
  ]);
  assert.deepEqual(scheduler.onHolders(0, 3, ['a', 'b'], 130), [
    { type: 'REQUEST_CHUNK', peerId: 'a', chunkIndex: 0, requestId: 1 },
  ]);
  assert.deepEqual(scheduler.tick(229), []);
  assert.deepEqual(scheduler.tick(230), [
    { type: 'REQUEST_CHUNK', peerId: 'b', chunkIndex: 0, requestId: 2 },
  ]);
  assert.equal(scheduler.getPeerPerformance().get('a').recentFailures, 1);
});

test('backs off once for an empty holder reply and immediately retries a send failure', () => {
  const scheduler = new ChunkRequestScheduler({ initialQueryBackoffMs: 20 });
  scheduler.updatePlan(plan(0), 1, 0);
  assert.deepEqual(scheduler.onHolders(0, 1, [], 1), []);
  assert.deepEqual(scheduler.tick(20), []);
  assert.deepEqual(scheduler.tick(21), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 2 },
  ]);
  assert.deepEqual(scheduler.onHolders(0, 2, ['a', 'b'], 30), [
    { type: 'REQUEST_CHUNK', peerId: 'a', chunkIndex: 0, requestId: 1 },
  ]);
  assert.deepEqual(scheduler.onRequestSendFailed('a', 0, 1, 31), [
    { type: 'REQUEST_CHUNK', peerId: 'b', chunkIndex: 0, requestId: 2 },
  ]);
  assert.deepEqual(scheduler.onRequestSendFailed('a', 0, 1, 32), []);
  assert.equal(scheduler.getPeerPerformance().get('a').pendingRequests, 0);
});

test('replans a delivered chunk if the viewer could not cache it', () => {
  const scheduler = new ChunkRequestScheduler();
  scheduler.updatePlan(plan(0), 1, 0);
  scheduler.onHolders(0, 1, ['a'], 10);
  scheduler.onData('a', {
    opcode: DataOpcode.PAYLOAD, requestId: 1, chunkIndex: 0,
    data: new Uint8Array(10),
  }, 20, true);
  assert.deepEqual(scheduler.updatePlan(plan(0), 1, 30), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 2 },
  ]);
});

test('limits parallel work, frees slots, and cancels obsolete revision work', () => {
  const scheduler = new ChunkRequestScheduler({
    maxConcurrentQueries: 1, maxConcurrentRequests: 1,
    maxConcurrentRequestsPerPeer: 1,
  });
  assert.deepEqual(scheduler.updatePlan(plan(0, 1), 1, 0), [
    { type: 'QUERY_HOLDERS', chunkIndex: 0, queryToken: 1 },
  ]);
  assert.deepEqual(scheduler.onHolders(0, 1, ['a'], 10), [
    { type: 'REQUEST_CHUNK', peerId: 'a', chunkIndex: 0, requestId: 1 },
    { type: 'QUERY_HOLDERS', chunkIndex: 1, queryToken: 2 },
  ]);
  assert.deepEqual(scheduler.onHolders(1, 2, ['a'], 20), []);
  assert.deepEqual(scheduler.updatePlan(plan(1), 2, 30), [
    { type: 'QUERY_HOLDERS', chunkIndex: 1, queryToken: 3 },
  ]);
  assert.equal(scheduler.getPeerPerformance().get('a').pendingRequests, 0);
  assert.deepEqual(scheduler.onHolders(1, 2, ['a'], 40), []);
  assert.deepEqual(scheduler.onData('a', {
    opcode: DataOpcode.PAYLOAD, requestId: 1, chunkIndex: 0,
    data: new Uint8Array(1),
  }, 40, true), []);
  assert.deepEqual(scheduler.onHolders(1, 3, ['a'], 50), [
    { type: 'REQUEST_CHUNK', peerId: 'a', chunkIndex: 1, requestId: 2 },
  ]);
  assert.deepEqual(scheduler.markOwned(1, 60), []);
  assert.equal(scheduler.getPeerPerformance().get('a').pendingRequests, 0);
  assert.deepEqual(scheduler.updatePlan(plan(1), 1, 70), []);
});
