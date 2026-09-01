const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PeerConnectionController,
} = require('../dist/packages/webrtc/peer-connection.js');

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

class FakePeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.createdChannels = [];
    this.closed = false;
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
  }

  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label);
    channel.options = options;
    this.createdChannels.push(channel);
    return channel;
  }

  async setLocalDescription(description) {
    if (description?.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }

    if (description) {
      this.localDescription = description;
    } else if (this.remoteDescription?.type === 'offer') {
      this.localDescription = { type: 'answer', sdp: 'answer-sdp' };
    } else {
      this.localDescription = { type: 'offer', sdp: 'offer-sdp' };
    }

    this.signalingState =
      this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState =
      description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      throw new Error('remoteDescription is required');
    }
    this.addedCandidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

function createController(overrides = {}) {
  const connection = new FakePeerConnection();
  const descriptions = [];
  const candidates = [];
  const channels = [];
  const controller = new PeerConnectionController({
    initiator: true,
    polite: false,
    createPeerConnection: () => connection,
    onDescription: (description) => descriptions.push(description),
    onIceCandidate: (candidate) => candidates.push(candidate),
    onDataChannel: (channel) => channels.push(channel),
    ...overrides,
  });

  return { controller, connection, descriptions, candidates, channels };
}

test('initiator creates one reliable ordered DataChannel and offers', async () => {
  const { controller, connection, descriptions, channels } =
    createController();

  const first = controller.start();
  const second = controller.start();
  assert.equal(first, second);
  assert.equal(first.label, 'peer-watchalong');
  assert.deepEqual(first.options, { ordered: true });
  assert.deepEqual(channels, [first]);

  await connection.onnegotiationneeded();
  assert.deepEqual(descriptions, [{ type: 'offer', sdp: 'offer-sdp' }]);
});

test('answerer applies an offer and returns an answer', async () => {
  const { controller, descriptions } = createController({
    initiator: false,
    polite: true,
  });

  assert.equal(controller.start(), undefined);
  await controller.handleRemoteDescription({ type: 'offer', sdp: 'offer' });

  assert.deepEqual(descriptions, [
    { type: 'answer', sdp: 'answer-sdp' },
  ]);
});

test('remote ICE is queued until a remote description exists', async () => {
  const { controller, connection } = createController({
    initiator: false,
    polite: true,
  });
  const candidate = {
    candidate: 'candidate:1',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };

  await controller.handleRemoteIceCandidate(candidate);
  assert.deepEqual(connection.addedCandidates, []);

  await controller.handleRemoteDescription({ type: 'offer', sdp: 'offer' });
  assert.deepEqual(connection.addedCandidates, [candidate]);
});

test('impolite peer ignores a colliding offer', async () => {
  const { controller, connection, descriptions } = createController();
  connection.signalingState = 'have-local-offer';
  connection.localDescription = { type: 'offer', sdp: 'local-offer' };

  await controller.handleRemoteDescription({
    type: 'offer',
    sdp: 'colliding-offer',
  });

  assert.equal(connection.remoteDescription, null);
  assert.deepEqual(descriptions, []);
});

test('local ICE is serialized to the shared signaling shape', async () => {
  const { connection, candidates } = createController();

  connection.onicecandidate({
    candidate: {
      candidate: 'candidate:2',
      sdpMid: 'data',
      sdpMLineIndex: 0,
    },
  });
  await Promise.resolve();

  assert.deepEqual(candidates, [
    {
      candidate: 'candidate:2',
      sdpMid: 'data',
      sdpMLineIndex: 0,
    },
  ]);
});

test('close is idempotent and closes owned resources', () => {
  const { controller, connection } = createController();
  const channel = controller.start();

  controller.close();
  controller.close();

  assert.equal(channel.closed, true);
  assert.equal(connection.closed, true);
});
