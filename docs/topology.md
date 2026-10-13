# Topology

The tracker owns placement and neighbor authorization. The host is the only
peer in Layer 0. Viewers occupy Layers 1–5; each layer targets three viewers
and has a hard limit of five. A new layer is used only when its parent layer is
nonempty. The configured maximum is 25 viewers plus the host; this has not
been load-tested.

## Placement and neighbors

For each new viewer, the tracker first fills Layers 1–5 toward the target of
three viewers per layer, then fills remaining slots toward the limit of five.
It returns `SESSION_FULL` when there is no slot.

Each viewer can have siblings in its own layer, parents in the layer above,
and children in the layer below. Layer 1 viewers use the host as their parent.
Other viewers receive up to two parents, preferring parents with fewer
assigned children. Neighbor relationships are symmetric. Holder queries return
only peers that are both active and authorized neighbors.

## WebRTC connections

For every authorized pair, the browser with the lexicographically smaller
tracker-assigned peer ID initiates the connection; the other is the polite
side for offer-collision handling. The tracker forwards SDP and ICE only
between authorized neighbors. A peer has at most one connection to a given
neighbor, and the room's peer count in the UI counts open DataChannels rather
than all room members.

## Changes and departures

When a viewer leaves, the tracker removes its chunk claims, compacts layers if
there is a gap, rebuilds neighbor assignments, and sends complete replacement
topologies to affected peers. This can change a remaining viewer's layer.
When the host disconnects, the room closes; there is no host migration.
