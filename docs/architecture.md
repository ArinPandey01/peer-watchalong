# Architecture

Peer Watchalong separates room coordination from media transfer. The Node.js
tracker receives JSON control messages over WebSocket. Browsers exchange MP4
chunks over WebRTC DataChannels; video bytes do not pass through the tracker.
This is a LAN-focused MVP, and its configured viewer limit is not a measured
capacity result.

## Runtime components

| Component | Owns |
| --- | --- |
| Host browser | Original local MP4, prepared chunks, and play/pause/seek actions |
| Tracker | Room membership, peer IDs, authorized topology, chunk-holder claims, media manifest, shared clock, and canonical playback state |
| Viewer browser | Chunk requests and cache, Media Source buffers, and local playback correction |

The tracker assigns a peer ID to each WebSocket connection and binds that ID
to its room. It rejects messages that claim another peer's identity, signaling
to a non-neighbor, and playback changes from a viewer. The room code is not
user authentication; anyone with the code can attempt to join.

## Joining and connecting

1. The host creates a room. The tracker registers it as the sole Layer 0 peer.
2. A viewer joins with the room code. The tracker assigns a viewer layer and
   returns its authorized parents, children, and siblings.
3. The tracker sends updated topologies to affected existing peers. Browsers
   exchange SDP and ICE through the tracker only with authorized neighbors.
4. Each authorized pair opens a reliable, ordered WebRTC DataChannel. The
   tracker relays signaling, not DataChannel traffic.
5. The viewer requests the current media manifest and playback state, then
   starts downloading the chunks needed near the host's position.

The tracker rebuilds affected topologies when a viewer leaves. An unexpected
host disconnect starts a 30-second resume window; an explicit departure closes
the room immediately. Room state is in memory, so a tracker restart loses it.
See [topology](topology.md) for placement and connection rules.

## Preparing and delivering media

The host uses `mp4box` to prepare initialization segments for the MP4's video
track and optional audio track. It groups nearby video and audio fragments in
one transferable media bundle per video interval. The viewer verifies the
bundle, then appends each track's fragment to its own Media Source buffer.
The host publishes a moving
manifest window containing track codecs, segment timing and size, and SHA-256
hashes for nearby segments. The tracker stores the current window and records
which peers claim to hold its chunks. It never stores the chunk bytes. The host
prepares the full local file before publishing the first window.

For each needed chunk, a viewer asks the tracker for holders. The tracker
returns only connected, authorized neighbors that have announced that chunk.
The viewer requests one of them over a DataChannel. A holder replies with the
payload or `NOT_AVAILABLE`; large chunks are split into bounded DataChannel
packets and reassembled. The viewer checks size and hash before caching,
announcing ownership, and serving the chunk to other authorized peers.

Chunk claims are advisory. A holder may disconnect or lack a claimed chunk, so
the viewer retries another holder or queries again after backoff. The current
cache keeps nearby chunks in browser memory. See [the network contract](contract.md) for message
formats and [scheduling](scheduling-and-sync.md) for request policy.

## Following the host timeline

The host sends play, pause, and seek updates to the tracker. The tracker checks
host identity, stamps the accepted state with its clock, and sends it to room
members. Viewers periodically sample tracker time, derive the expected media
position, and apply small corrections through playback rate or larger ones
through seeking. A higher revision identifies a new timeline after a host
seek, so old chunk requests can be abandoned. Verified segments are appended
to the viewer's Media Source buffers. Viewers do not get local seek controls.

The thresholds and timing model are in
[scheduling and playback sync](scheduling-and-sync.md).

## Code boundaries

| Path | Responsibility |
| --- | --- |
| `apps/tracker` | WebSocket transport, room registry, topology, and control handling |
| `apps/web` | UI, MP4 preparation, chunk exchange, in-memory cache, and player |
| `packages/protocol` | Control types and validation, binary DataChannel codec |
| `packages/tracker-client` | Browser WebSocket client |
| `packages/webrtc` | Peer connection and DataChannel lifecycle |
| `packages/scheduler` | Chunk planning, holder choice, retries, clock and playback decisions |

There is no separate `buffer` package. The browser player and chunk cache live
in `apps/web`.
