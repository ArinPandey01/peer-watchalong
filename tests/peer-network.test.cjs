const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomPeerNetwork } = require('../apps/web/src/peer-network.ts');

class FakeTracker {
  identity = { sessionId: 'room', peerId: 'peer-b' };
  listeners = new Map();
  descriptions = [];
  candidates = [];

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type, value) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }

  sendSdp(peerId, description) { this.descriptions.push({ peerId, description }); }
  sendIce(peerId, candidate) { this.candidates.push({ peerId, candidate }); }
}

test('connects only tracker-authorized peers and relays their signals and data', async () => {
  const tracker = new FakeTracker();
  const peers = new Map();
  const counts = [];
  const messages = [];
  const network = new RoomPeerNetwork(tracker, {
    createPeer: (options) => {
      const peer = {
        options,
        started: false,
        closed: false,
        descriptions: [],
        candidates: [],
        sent: [],
        start() { this.started = true; },
        async handleRemoteDescription(value) { this.descriptions.push(value); },
        async handleRemoteIceCandidate(value) { this.candidates.push(value); },
        async send(value) { this.sent.push(value); },
        close() { this.closed = true; },
      };
      peers.set(peers.size === 0 ? 'peer-a' : 'peer-c', peer);
      return peer;
    },
    onConnectedCount: (count) => counts.push(count),
    onMessage: (peerId, data) => messages.push({ peerId, data }),
  });
  network.start();
  tracker.emit('topology', { layer: 1, parents: ['peer-a'], children: ['peer-c'], siblings: [] });
  assert.equal(peers.get('peer-a').started, true);
  assert.equal(peers.get('peer-a').options.initiator, false);
  assert.equal(peers.get('peer-a').options.polite, true);
  assert.equal(peers.get('peer-c').options.initiator, true);
  assert.equal(peers.get('peer-c').options.polite, false);

  const description = { type: 'offer', sdp: 'offer' };
  const candidate = { candidate: 'ice', sdpMid: null, sdpMLineIndex: null };
  peers.get('peer-a').options.sendDescription(description);
  peers.get('peer-a').options.sendIceCandidate(candidate);
  assert.deepEqual(tracker.descriptions, [{ peerId: 'peer-a', description }]);
  assert.deepEqual(tracker.candidates, [{ peerId: 'peer-a', candidate }]);

  tracker.emit('signalSdp', { senderId: 'peer-a', payload: { description } });
  tracker.emit('signalIce', { senderId: 'peer-a', payload: { candidate } });
  tracker.emit('signalSdp', { senderId: 'unauthorized', payload: { description } });
  await Promise.resolve();
  assert.deepEqual(peers.get('peer-a').descriptions, [description]);
  assert.deepEqual(peers.get('peer-a').candidates, [candidate]);
  peers.get('peer-a').options.onDataChannelStateChange('open');
  peers.get('peer-a').options.onMessage(Uint8Array.of(1, 2));
  assert.equal(counts.at(-1), 1);
  assert.deepEqual(messages, [{ peerId: 'peer-a', data: Uint8Array.of(1, 2) }]);
  await network.send('peer-a', Uint8Array.of(3));
  assert.deepEqual(peers.get('peer-a').sent, [Uint8Array.of(3)]);
  await assert.rejects(network.send('unauthorized', Uint8Array.of(3)));

  tracker.emit('topology', { layer: 1, parents: [], children: ['peer-c'], siblings: [] });
  assert.equal(peers.get('peer-a').closed, true);
  assert.equal(counts.at(-1), 0);
  network.close();
  assert.equal(peers.get('peer-c').closed, true);
  await assert.rejects(network.send('peer-c', Uint8Array.of(3)));
});
