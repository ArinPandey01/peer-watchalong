# WebRTC package

`WebRtcPeer` manages one browser-to-browser connection and one reliable,
ordered DataChannel. It handles offer collisions, queues remote ICE candidates
until a remote description exists, and bounds outgoing writes with DataChannel
watermarks. It does not choose neighbors, request chunks, or synchronize video.

The caller supplies whether this peer initiates and whether it is polite. The
web app uses tracker-assigned peer IDs: the lexicographically smaller ID
initiates, and the larger ID is polite. The caller also supplies callbacks to
send SDP and ICE through the tracker, and routes incoming tracker signals back
to `handleRemoteDescription` and `handleRemoteIceCandidate`.

The main lifecycle is `start()`, then `send(bytes)` and incoming `onMessage`
callbacks, then `close()`. `send()` resolves when the browser accepts bytes
into its DataChannel send buffer. It does **not** confirm remote delivery;
request IDs, timeouts, retries, and chunk validation belong to the web app and
[scheduler](../scheduler/README.md).

See [architecture](../../docs/architecture.md) for the tracker/peer boundary
and [topology](../../docs/topology.md) for neighbor selection.
