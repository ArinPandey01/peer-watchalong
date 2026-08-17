# Tracker

## Boundary

The tracker owns room membership, peer IDs, topology, signaling authorization,
the chunk ledger, canonical playback state, and the shared clock. It never
stores or forwards media bytes and never schedules peer downloads.

## In-memory state

```ts
interface RoomState {
  sessionId: SessionId;
  hostPeerId: PeerId;
  peers: Map<PeerId, PeerState>;
  chunkHolders: Map<number, Set<PeerId>>;
  playback: PlaybackState;
}

interface PeerState {
  peerId: PeerId;
  connection: WebSocket;
  layer: Layer;
  topology: PeerTopology;
  connectedAt: number;
  lastSeenAt: number;
}
```

The tracker also maps each WebSocket connection to its registered room and
peer. That connection binding is authoritative; incoming `senderId` values are
only checked against it.

## Room lifecycle

### Create

1. The host generates a `sessionId` and sends `CREATE_ROOM_REQ`.
2. The tracker rejects an existing ID.
3. The tracker creates the room, assigns the host a `peerId`, and places it in
   Layer 0.
4. The tracker binds the WebSocket to that identity and replies with
   `CREATE_ROOM_RES`.

### Join

1. A viewer sends `JOIN_ROOM_REQ` with the room's `sessionId`.
2. The tracker verifies the room and available capacity.
3. It assigns a `peerId`, computes topology, and binds the connection.
4. It returns `JOIN_ROOM_RES` and updates affected neighbors.

A WebSocket may register only once.

### Disconnect

For a viewer, the tracker removes the peer, its ledger claims, and all neighbor
references, then repairs affected parent assignments. For the host, it closes
the room and disconnects or notifies all viewers.

## Message handling

For every control message, the tracker:

1. parses and validates the message;
2. checks protocol version;
3. verifies connection-bound identity and room membership;
4. checks role and topology authorization;
5. applies the state change; and
6. sends a response with `replyTo` when applicable.

Signaling is relayed only when source and target are authorized neighbors.
`CHUNK_QUERY_RES` includes only active, authorized holders and excludes the
requester.

## Chunk ledger

The ledger contains peer claims, not verified possession. Announcements are
idempotent. All claims are removed when a peer disconnects. A peer receiving
`NOT_AVAILABLE` handles fallback locally; stale-claim cleanup beyond
disconnect handling can be added after measurement.

## Playback and clock

Only messages bound to the host peer may change canonical playback state. The
tracker assigns `effectiveAt` using its clock and stores the latest revision.
Late joiners receive the latest state. Clock responses include tracker receive
and send timestamps needed for offset estimation.

## Initial limitations

- State is lost when the tracker restarts.
- There is no host migration.
- There is no multi-tracker coordination.
- Rate limits, heartbeat intervals, and stale-peer timeouts remain tuning
  values to define during implementation.
