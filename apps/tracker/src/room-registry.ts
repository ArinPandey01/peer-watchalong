import type {
  Layer,
  PeerId,
  PeerTopology,
  PlaybackState,
  PlaybackUpdate,
  SessionId,
} from '../../../packages/protocol/control';
import {
  assignViewerLayer,
  buildPeerTopologies,
  compactViewerLayers,
  TopologyCapacityError,
} from './topology';

export interface PeerState {
  peerId: PeerId;
  layer: Layer;
  topology: PeerTopology;
  connectedAt: number;
  lastSeenAt: number;
}

export interface RoomState {
  sessionId: SessionId;
  hostPeerId: PeerId;
  peers: Map<PeerId, PeerState>;
  chunkHolders: Map<number, Set<PeerId>>;
  playback: PlaybackState;
}

export interface MembershipResult {
  room: RoomState;
  peer: PeerState;
  affectedPeerIds: PeerId[];
}

export interface PeerRemovalResult {
  removed: boolean;
  roomClosed: boolean;
  affectedPeerIds: PeerId[];
}

export type RoomRegistryErrorCode =
  | 'SESSION_ALREADY_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_FULL'
  | 'PEER_NOT_FOUND'
  | 'NOT_HOST'
  | 'STALE_PLAYBACK_REVISION';

export class RoomRegistryError extends Error {
  readonly code: RoomRegistryErrorCode;

  constructor(
    code: RoomRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomRegistryError';
    this.code = code;
  }
}

export interface RoomRegistryOptions {
  createPeerId?: () => PeerId;
  now?: () => number;
}

export class RoomRegistry {
  private readonly rooms = new Map<SessionId, RoomState>();
  private readonly allocatedPeerIds = new Set<PeerId>();
  private readonly createPeerId: () => PeerId;
  private readonly now: () => number;

  constructor(options: RoomRegistryOptions = {}) {
    this.createPeerId = options.createPeerId ?? defaultCreatePeerId;
    this.now = options.now ?? Date.now;
  }

  createRoom(sessionId: SessionId): MembershipResult {
    assertSessionId(sessionId);
    if (this.rooms.has(sessionId)) {
      throw new RoomRegistryError(
        'SESSION_ALREADY_EXISTS',
        `Session ${sessionId} already exists`,
      );
    }

    const now = this.now();
    const hostPeerId = this.allocatePeerId();
    const host: PeerState = {
      peerId: hostPeerId,
      layer: 0,
      topology: emptyTopology(0),
      connectedAt: now,
      lastSeenAt: now,
    };
    const room: RoomState = {
      sessionId,
      hostPeerId,
      peers: new Map([[hostPeerId, host]]),
      chunkHolders: new Map(),
      playback: {
        playing: false,
        mediaTime: 0,
        effectiveAt: now,
        playbackRate: 1,
        revision: 0,
      },
    };

    this.rooms.set(sessionId, room);
    this.refreshTopologies(room);

    return { room, peer: host, affectedPeerIds: [hostPeerId] };
  }

  joinRoom(sessionId: SessionId): MembershipResult {
    const room = this.requireRoom(sessionId);
    let layer: Layer;

    try {
      layer = assignViewerLayer(room.peers.values());
    } catch (error) {
      if (error instanceof TopologyCapacityError) {
        throw new RoomRegistryError(
          'SESSION_FULL',
          `Session ${sessionId} is full`,
        );
      }
      throw error;
    }

    const now = this.now();
    const peerId = this.allocatePeerId();
    const peer: PeerState = {
      peerId,
      layer,
      topology: emptyTopology(layer),
      connectedAt: now,
      lastSeenAt: now,
    };

    room.peers.set(peerId, peer);
    const affectedPeerIds = this.refreshTopologies(room);
    return { room, peer, affectedPeerIds };
  }

  getRoom(sessionId: SessionId): RoomState | undefined {
    return this.rooms.get(sessionId);
  }

  getPeer(sessionId: SessionId, peerId: PeerId): PeerState | undefined {
    return this.rooms.get(sessionId)?.peers.get(peerId);
  }

  touchPeer(sessionId: SessionId, peerId: PeerId): void {
    this.requirePeer(this.requireRoom(sessionId), peerId).lastSeenAt = this.now();
  }

  removePeer(sessionId: SessionId, peerId: PeerId): PeerRemovalResult {
    const room = this.rooms.get(sessionId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer) {
      return { removed: false, roomClosed: false, affectedPeerIds: [] };
    }

    if (peerId === room.hostPeerId) {
      const affectedPeerIds = this.closeRoom(sessionId);
      return { removed: true, roomClosed: true, affectedPeerIds };
    }

    room.peers.delete(peerId);
    this.allocatedPeerIds.delete(peerId);
    this.removeChunkClaims(room, peerId);

    const compactedLayers = compactViewerLayers(room.peers.values());
    for (const [remainingPeerId, layer] of compactedLayers) {
      this.requirePeer(room, remainingPeerId).layer = layer;
    }

    const affectedPeerIds = this.refreshTopologies(room);
    return { removed: true, roomClosed: false, affectedPeerIds };
  }

  closeRoom(sessionId: SessionId): PeerId[] {
    const room = this.rooms.get(sessionId);
    if (!room) {
      return [];
    }

    const peerIds = [...room.peers.keys()];
    for (const peerId of peerIds) {
      this.allocatedPeerIds.delete(peerId);
    }
    this.rooms.delete(sessionId);
    return peerIds;
  }

  announceChunk(
    sessionId: SessionId,
    peerId: PeerId,
    chunkIndex: number,
  ): void {
    const room = this.requireRoom(sessionId);
    this.requirePeer(room, peerId);
    assertChunkIndex(chunkIndex);

    let holders = room.chunkHolders.get(chunkIndex);
    if (!holders) {
      holders = new Set();
      room.chunkHolders.set(chunkIndex, holders);
    }
    holders.add(peerId);
  }

  getEligibleChunkHolders(
    sessionId: SessionId,
    requesterId: PeerId,
    chunkIndex: number,
  ): PeerId[] {
    const room = this.requireRoom(sessionId);
    const requester = this.requirePeer(room, requesterId);
    assertChunkIndex(chunkIndex);

    const authorizedNeighbors = new Set([
      ...requester.topology.parents,
      ...requester.topology.children,
      ...requester.topology.siblings,
    ]);
    const holders = room.chunkHolders.get(chunkIndex);
    if (!holders) {
      return [];
    }

    return [...holders]
      .filter(
        (holderId) =>
          holderId !== requesterId &&
          room.peers.has(holderId) &&
          authorizedNeighbors.has(holderId),
      )
      .sort();
  }

  areNeighbors(
    sessionId: SessionId,
    firstPeerId: PeerId,
    secondPeerId: PeerId,
  ): boolean {
    const first = this.requirePeer(this.requireRoom(sessionId), firstPeerId);
    return (
      first.topology.parents.includes(secondPeerId) ||
      first.topology.children.includes(secondPeerId) ||
      first.topology.siblings.includes(secondPeerId)
    );
  }

  setPlayback(
    sessionId: SessionId,
    peerId: PeerId,
    update: PlaybackUpdate,
  ): PlaybackState {
    const room = this.requireRoom(sessionId);
    this.requirePeer(room, peerId);

    if (peerId !== room.hostPeerId) {
      throw new RoomRegistryError(
        'NOT_HOST',
        'Only the host may update playback',
      );
    }
    if (update.revision < room.playback.revision) {
      throw new RoomRegistryError(
        'STALE_PLAYBACK_REVISION',
        'Playback revision is older than the canonical state',
      );
    }

    room.playback = {
      ...update,
      effectiveAt: this.now(),
    };
    return room.playback;
  }

  private refreshTopologies(room: RoomState): PeerId[] {
    const nextTopologies = buildPeerTopologies(room.peers.values());
    const affectedPeerIds: PeerId[] = [];

    for (const [peerId, nextTopology] of nextTopologies) {
      const peer = this.requirePeer(room, peerId);
      if (!sameTopology(peer.topology, nextTopology)) {
        peer.topology = nextTopology;
        affectedPeerIds.push(peerId);
      }
    }

    return affectedPeerIds.sort();
  }

  private removeChunkClaims(room: RoomState, peerId: PeerId): void {
    for (const [chunkIndex, holders] of room.chunkHolders) {
      holders.delete(peerId);
      if (holders.size === 0) {
        room.chunkHolders.delete(chunkIndex);
      }
    }
  }

  private requireRoom(sessionId: SessionId): RoomState {
    const room = this.rooms.get(sessionId);
    if (!room) {
      throw new RoomRegistryError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} does not exist`,
      );
    }
    return room;
  }

  private requirePeer(room: RoomState, peerId: PeerId): PeerState {
    const peer = room.peers.get(peerId);
    if (!peer) {
      throw new RoomRegistryError(
        'PEER_NOT_FOUND',
        `Peer ${peerId} does not exist in session ${room.sessionId}`,
      );
    }
    return peer;
  }

  private allocatePeerId(): PeerId {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const peerId = this.createPeerId();
      if (peerId && !this.allocatedPeerIds.has(peerId)) {
        this.allocatedPeerIds.add(peerId);
        return peerId;
      }
    }
    throw new Error('Unable to allocate a unique peer ID');
  }
}

function defaultCreatePeerId(): PeerId {
  return globalThis.crypto.randomUUID();
}

function emptyTopology(layer: Layer): PeerTopology {
  return { layer, parents: [], children: [], siblings: [] };
}

function sameTopology(left: PeerTopology, right: PeerTopology): boolean {
  return (
    left.layer === right.layer &&
    sameArray(left.parents, right.parents) &&
    sameArray(left.children, right.children) &&
    sameArray(left.siblings, right.siblings)
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertSessionId(sessionId: SessionId): void {
  if (sessionId.trim().length === 0) {
    throw new Error('Session ID must not be empty');
  }
}

function assertChunkIndex(chunkIndex: number): void {
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > 0xffff_ffff
  ) {
    throw new Error('Chunk index must be an unsigned 32-bit integer');
  }
}
