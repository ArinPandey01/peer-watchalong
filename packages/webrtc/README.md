# WebRTC transport

This package owns the browser transport lifecycle for one tracker-authorized
neighbor. It deliberately does not decide room membership, topology, chunk
selection, retries, or playback policy.

## Responsibilities

- create one ordered, reliable DataChannel for an authorized peer pair;
- exchange offer/answer descriptions and trickle ICE through injected tracker
  callbacks;
- resolve simultaneous offers with the perfect-negotiation pattern;
- queue ICE candidates that arrive before the remote description;
- expose incoming binary messages as `Uint8Array`; and
- bound application writes using DataChannel high/low watermarks.

## Roles

The topology rules determine `initiator`:

- a child initiates its connection to a parent; and
- for siblings, the lexicographically smaller peer ID initiates.

The perfect-negotiation `polite` role is separate. Assign it deterministically
so exactly one side is polite; for example, use the lexicographically larger
peer ID.

## Tracker integration

```ts
import { WebRtcPeer } from './packages/webrtc';

const peer = new WebRtcPeer({
  initiator: shouldInitiate,
  polite: localPeerId > remotePeerId,
  sendDescription: (description) => {
    tracker.sendSignalSdp(remotePeerId, description);
  },
  sendIceCandidate: (candidate) => {
    tracker.sendSignalIce(remotePeerId, candidate);
  },
  onMessage: (packet) => {
    // Decode with packages/protocol/data-codec once the protocol PR lands.
    handleDataPacket(remotePeerId, packet);
  },
});

peer.start();

// Route tracker SIGNAL_SDP and SIGNAL_ICE messages for remotePeerId here.
await peer.handleRemoteDescription(description);
await peer.handleRemoteIceCandidate(candidate);
```

`send()` resolves once the browser accepts a message into its outgoing
DataChannel buffer. It is not a delivery acknowledgement. Chunk request IDs,
timeouts, retries, and validation remain application-protocol concerns.

## References

- [WebRTC 1.0 specification](https://www.w3.org/TR/webrtc/)
- [Perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [DataChannel bufferedamountlow](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedamountlow_event)
