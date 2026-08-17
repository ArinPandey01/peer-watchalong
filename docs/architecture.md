# Architecture

## Purpose

Peer Watchalong is a LAN peer-to-peer video watch-party system written in
TypeScript. One participant owns a local video file and approximately 30
participants on the same network watch it together.

The system has two primary goals:

- keep playback aligned to a host-controlled timeline; and
- distribute media through the peer swarm so the original host does not need
  to upload every chunk to every viewer.

Peer Watchalong is not a centralized video-streaming service. The tracker
coordinates the swarm, while browsers transfer media directly over WebRTC
DataChannels.

## Architectural principles

1. **Separate control from media.** Control messages travel through the
   tracker; media bytes travel directly between browsers.
2. **Keep the tracker out of the media path.** The tracker must never relay,
   store, or inspect video chunks.
3. **Make the host authoritative for playback.** The host decides when the
   party plays, pauses, or seeks. The tracker stores and distributes that
   canonical state.
4. **Make the tracker authoritative for identity and topology.** Clients do
   not choose trusted peer identities or connect to arbitrary swarm members.
5. **Pull media on demand.** Viewers decide which chunks they need and request
   them from eligible peers.
6. **Prefer browser and transport primitives.** Start with WebRTC's ordering,
   reliability, congestion control, and message boundaries. Add custom
   mechanisms only when measurements justify them.

## Runtime components

### Host browser

The host browser owns the original local video and occupies Layer 0 of the
swarm.

It is responsible for:

- preparing deterministic, addressable media chunks;
- serving chunks to authorized peers, especially peers in Layer 1;
- issuing canonical play, pause, and seek actions; and
- participating in signaling and chunk announcements like other peers where
  applicable.

The host is the source of media and playback intent, but it should not be the
only long-term source of every chunk. Once viewers acquire chunks, they can
serve them onward.

### Tracker

The tracker is a Node.js service using WebSocket for the control plane.

It is responsible for:

- creating or joining swarms and registering peers;
- assigning layers and authorized neighbor relationships;
- relaying authorized WebRTC signaling;
- maintaining an in-memory ledger of peers' chunk claims;
- answering chunk-discovery queries using topology constraints;
- storing the canonical playback state established by the host;
- providing a shared clock reference; and
- eventually tracking lightweight peer and session health.

### Viewer peer

A viewer is a browser client assigned to Layers 1 through 5.

It is responsible for:

- establishing DataChannels with tracker-authorized neighbors;
- determining which media chunks it needs;
- discovering eligible holders through the tracker;
- requesting, validating, caching, and serving chunks;
- announcing acquired chunks to the tracker;
- appending media to MSE; and
- aligning local playback with the canonical timeline.

## Communication planes

```text
                         Control plane
                WebSocket messages and signaling

  +--------------+ <----------------------------> +-----------+
  | Host browser |                                 |           |
  +--------------+                                 |  Tracker  |
         ^                                         |           |
         |                                         +-----------+
         |                                               ^
         | Media plane                                   |
         | WebRTC DataChannels                           | Control plane
         v                                               v
  +--------------+ <----------------------------> +-------------+
  | Viewer peer  |          Media plane            | Viewer peer |
  +--------------+                                 +-------------+
```

WebSocket carries application control messages between each browser and the
tracker. This includes registration, topology, chunk discovery, signaling,
clock exchange, and playback state.

WebRTC DataChannels carry application data messages between authorized peers.
These messages request or transfer chunks and explicitly report when a chunk
is unavailable.

WebRTC is a transport, not the application protocol. The shared protocol
package defines the meaning and serialization of messages on both planes.

## Core data flows

### Joining a swarm

1. A browser opens a WebSocket connection to the tracker.
2. The tracker authenticates or registers the connection and assigns its
   authoritative peer identity.
3. The tracker assigns the peer a topology position and authorized neighbors.
4. The browser exchanges SDP and ICE through the tracker only for authorized
   peers.
5. The browser establishes the required WebRTC DataChannels.
6. A viewer obtains current playback state and begins fetching chunks near the
   target playback position.

The detailed placement and connection rules belong in
topology.md.

### Acquiring a chunk

1. A viewer's scheduler identifies a needed chunk.
2. The viewer asks the tracker which authorized neighbors claim to hold it.
3. The tracker filters its ledger by the viewer's permitted topology and
   returns eligible holders.
4. The viewer selects a holder and sends one request over its DataChannel.
5. The holder returns the payload or explicitly reports that it is not
   available.
6. The viewer validates and stores the payload, then announces its new claim
   to the tracker.

A negative response and a timeout have different meanings. A negative response
confirms that the peer is reachable but lacks the chunk; a timeout can indicate
loss, congestion, overload, or disconnection.

Request selection, retries, deadlines, and priorities belong in
scheduling-and-sync.md. Message shapes and binary
layouts belong in contract.md.

### Synchronizing playback

1. The host issues a playback action.
2. The tracker validates that the action came from the host and records the
   canonical state against its clock.
3. The tracker distributes or returns that state to viewers.
4. Each viewer estimates tracker-clock offset and derives the expected media
   position locally.
5. The viewer corrects small drift gradually and large drift by seeking.

Major discontinuities use a playback revision or epoch so obsolete buffering
and scheduling work can be abandoned. Detailed state, clock, and correction
rules belong in scheduling-and-sync.md.

## Logical topology

The host occupies Layer 0. Viewers occupy Layers 1 through 5, with a target of
approximately three and a hard limit of approximately five viewers per layer.
The intended scale is roughly 30 participants on one LAN.

Peers may be authorized to communicate with selected peers in the layer above,
the layer below, or their own layer. Authorization defines which connections
are permitted; it does not require every permitted connection to remain open
permanently.

The tracker is the source of truth for these relationships. A chunk holder is
not eligible merely because it belongs to the same swarm—it must also be an
authorized neighbor of the requester.

Placement, capacity, rebalancing, and connection lifecycle rules belong in
topology.md.

## Codebase boundaries

The intended monorepo is divided by responsibility:

```text
apps/
  tracker/    Control-plane service and authoritative swarm state
  host/       Browser experience for the media owner
  peer/       Browser experience for viewers

packages/
  protocol/   Shared contracts, serialization, parsing, and validation
  webrtc/     Thin RTCPeerConnection and RTCDataChannel wrappers
  scheduler/  Chunk demand, holder choice, retry, and prioritization
  buffer/     Chunk storage, MSE integration, and playback correction
```

Dependencies should point toward narrow shared packages. In particular:

- `protocol` contains no tracker, browser, or scheduling policy;
- `webrtc` exposes transport behavior but contains no swarm scheduling;
- `scheduler` decides what to request but does not own transport or MSE;
- `buffer` owns media assembly and local playback behavior; and
- `tracker` owns shared control state but no media-transfer behavior.

## State ownership

| State | Authority | Consumers |
| --- | --- | --- |
| Original media file | Host browser | Host chunking pipeline |
| Peer identity | Tracker | Host and viewers |
| Swarm membership | Tracker | Host and viewers |
| Topology and authorization | Tracker | Signaling and peers |
| Chunk possession claims | Tracker ledger | Peer schedulers |
| Cached chunk bytes | Individual peer | Local buffer and neighbors |
| Playback intent | Host browser | Tracker |
| Canonical playback state | Tracker, from host actions | All browsers |
| Local buffer and playback position | Individual browser | Local sync logic |

The chunk ledger is advisory: it records what peers claim to possess and can
become stale. Receiving peers must handle an explicit unavailable response and
must validate received data rather than treating tracker discovery as proof.


