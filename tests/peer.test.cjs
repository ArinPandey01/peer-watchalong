const test = require('node:test');
const assert = require('node:assert/strict');

const { WebRtcPeer } = require('../dist/packages/webrtc/peer.js');

class FakeDataChannel {
  constructor(label, state = 'connecting') {
    this.label = label;
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

  receive(data) {
    this.onmessage?.({ data });
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.channel = null;
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
  }

  createDataChannel(label) {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async setLocalDescription() {
    this.localDescription = this.remoteDescription?.type === 'offer'
      ? { type: 'answer', sdp: 'answer' }
      : { type: 'offer', sdp: 'offer' };
    this.signalingState =
      this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState =
      description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate() {}

  close() {
    this.connectionState = 'closed';
  }
}

function createPeer(overrides = {}) {
  const connection = new FakePeerConnection();
  const descriptions = [];
  const candidates = [];
  const messages = [];
  const errors = [];
  const peer = new WebRtcPeer({
    initiator: true,
    polite: false,
    createPeerConnection: () => connection,
    sendDescription: (description) => descriptions.push(description),
    sendIceCandidate: (candidate) => candidates.push(candidate),
    onMessage: (message) => messages.push(message),
    onError: (error, context) => errors.push({ error, context }),
    ...overrides,
  });

  return { peer, connection, descriptions, candidates, messages, errors };
}

test('composes negotiation and buffered binary sending', async () => {
  const { peer, connection, descriptions } = createPeer();

  peer.start();
  await connection.onnegotiationneeded();
  assert.deepEqual(descriptions, [{ type: 'offer', sdp: 'offer' }]);
  assert.equal(peer.dataChannelState, 'connecting');

  connection.channel.open();
  await peer.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual(connection.channel.sent, [new Uint8Array([1, 2, 3])]);
});

test('answerer attaches the remotely announced DataChannel', async () => {
  const { peer, connection, messages } = createPeer({
    initiator: false,
    polite: true,
  });
  peer.start();
  assert.equal(peer.dataChannelState, 'unavailable');

  const remoteChannel = new FakeDataChannel('peer-watchalong', 'open');
  connection.ondatachannel({ channel: remoteChannel });
  remoteChannel.receive(Uint8Array.from([8, 9]).buffer);

  assert.equal(peer.dataChannelState, 'open');
  assert.deepEqual(messages, [new Uint8Array([8, 9])]);
});

test('reports an early send without hiding the rejection', async () => {
  const { peer, errors } = createPeer({
    initiator: false,
    polite: true,
  });

  await assert.rejects(peer.send(new Uint8Array([1])), /not available yet/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'data-channel-send');
});

test('close prevents further work', async () => {
  const { peer } = createPeer();
  peer.start();
  peer.close();
  peer.close();

  await assert.rejects(peer.send(new Uint8Array([1])), /WebRtcPeer is closed/);
  assert.throws(() => peer.start(), /WebRtcPeer is closed/);
});
