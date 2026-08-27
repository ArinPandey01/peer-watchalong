const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BufferedDataChannel,
} = require('../dist/packages/webrtc/data-channel.js');

class FakeDataChannel {
  constructor(state = 'connecting') {
    this.label = 'peer-watchalong';
    this.readyState = state;
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'blob';
    this.sent = [];
    this.onopen = null;
    this.onbufferedamountlow = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclosing = null;
    this.onclose = null;
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error('channel is not open');
    }
    const copy = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).slice();
    this.sent.push(copy);
    this.bufferedAmount += copy.byteLength;
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  drainTo(bufferedAmount) {
    const wasAbove =
      this.bufferedAmount > this.bufferedAmountLowThreshold;
    this.bufferedAmount = bufferedAmount;
    if (
      wasAbove &&
      bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.onbufferedamountlow?.();
    }
  }

  receive(data) {
    this.onmessage?.({ data });
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

test('configures binary delivery and low-water notification', () => {
  const raw = new FakeDataChannel();
  new BufferedDataChannel(raw, {
    highWaterMark: 100,
    lowWaterMark: 25,
  });

  assert.equal(raw.binaryType, 'arraybuffer');
  assert.equal(raw.bufferedAmountLowThreshold, 25);
});

test('queues sends until the channel opens', async () => {
  const raw = new FakeDataChannel();
  const channel = new BufferedDataChannel(raw, {
    highWaterMark: 100,
    lowWaterMark: 25,
  });
  const input = new Uint8Array([1, 2, 3]);

  const sent = channel.send(input);
  input[0] = 9;
  assert.equal(channel.pendingMessageCount, 1);

  raw.open();
  await sent;
  assert.deepEqual(raw.sent, [new Uint8Array([1, 2, 3])]);
  assert.equal(channel.pendingMessageCount, 0);
});

test('uses bufferedamountlow to drain backpressured messages', async () => {
  const raw = new FakeDataChannel('open');
  const channel = new BufferedDataChannel(raw, {
    highWaterMark: 10,
    lowWaterMark: 3,
  });

  await channel.send(new Uint8Array(8));
  const second = channel.send(new Uint8Array([7, 8, 9, 10]));
  assert.equal(channel.pendingMessageCount, 1);

  raw.drainTo(3);
  await second;
  assert.equal(raw.sent.length, 2);
  assert.equal(channel.pendingMessageCount, 0);
});

test('delivers incoming ArrayBuffers as Uint8Array', () => {
  const received = [];
  const raw = new FakeDataChannel('open');
  new BufferedDataChannel(raw, {
    onMessage: (data) => received.push(data),
  });

  raw.receive(Uint8Array.from([4, 5, 6]).buffer);
  assert.deepEqual(received, [new Uint8Array([4, 5, 6])]);
});

test('rejects messages above a configured maximum', async () => {
  const raw = new FakeDataChannel('open');
  const channel = new BufferedDataChannel(raw, { maxMessageSize: 3 });

  await assert.rejects(
    channel.send(new Uint8Array(4)),
    /maximum is 3 bytes/,
  );
  assert.deepEqual(raw.sent, []);
});

test('close rejects queued sends and is idempotent', async () => {
  const raw = new FakeDataChannel();
  const channel = new BufferedDataChannel(raw);
  const pending = channel.send(new Uint8Array([1]));

  channel.close();
  channel.close();

  await assert.rejects(pending, /closed before send/);
  assert.equal(raw.readyState, 'closed');
});
