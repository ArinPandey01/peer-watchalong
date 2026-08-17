# Topology

## Shape

- The host is the only peer in Layer 0.
- Viewers occupy Layers 1–5.
- Each viewer layer targets 3 peers and has a hard limit of 5.
- The tracker is authoritative for placement and neighbor authorization.
- A peer's layer stays stable during normal joins and departures.
- A layer can contain no less than 2 peer if there are at least 4 peers.

## Placement

For a new viewer, the tracker:

1. fills Layers 1–5 in order to the target of 3;
2. then fills spare capacity in order to the hard limit of 5; and
3. returns `SESSION_FULL` when every viewer layer is full.

A layer may be used only when the layer above it contains a peer. This model
supports at most 25 viewers plus the host.

## Authorized neighbors

A viewer may be authorized with:

- parents in the layer above;
- children in the layer below; and
- siblings in the same layer.

Layer 1 viewers use the host as their parent. Other viewers receive up to two
parents, preferring peers with fewer assigned children. All peers in the same
viewer layer may be siblings because a layer contains at most five peers.

Authorization is symmetric: if A lists B as a neighbor, B lists A in the
corresponding relationship. Chunk discovery returns only authorized neighbors.

## Connections

- A child initiates the WebRTC connection to its parent.
- Between siblings, the peer with the lexicographically smaller `peerId`
  initiates.
- Only one peer connection exists for an authorized pair.
- Authorization permits a connection; it does not require every sibling
  connection to remain open.
- The tracker rejects signaling between unauthorized peers.

## Changes and departures

When topology changes, the tracker sends each affected peer a complete
replacement topology, not a partial patch.

When a viewer leaves, the tracker removes it from all neighbor lists and gives
its children replacement parents where possible. If the viewer leaving doesn't create a dramatic drop in performance, it does not rebalance layers
only to make them visually even.

When the host disconnects, the room closes. Host migration is outside the
initial scope.
