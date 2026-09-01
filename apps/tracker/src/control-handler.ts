import type {
  ClockSyncRes,
  ControlMessage,
  CreateRoomRes,
  ErrorMessage,
  JoinRoomRes,
  PeerId,
  PlaybackStateEvent,
  PlaybackStateRes,
  SessionId,
  TopologyUpdateEvent,
} from '../../../packages/protocol/control';
import {
  ControlValidationError,
  parseControlMessage,
  validateControlMessage,
} from '../../../packages/protocol/control-validator';
import {
  RoomRegistry,
  RoomRegistryError,
  type RoomRegistryErrorCode,
} from './room-registry';

export type ConnectionId = string;

export interface ConnectionBinding {
  sessionId: SessionId;
  peerId: PeerId;
}

export interface OutboundControlMessage {
  connectionId: ConnectionId;
  message: ControlMessage;
}

export interface ControlHandlerOptions {
  registry?: RoomRegistry;
  createMessageId?: () => string;
  now?: () => number;
}

/**
 * Applies tracker rules without depending on a WebSocket implementation.
 * A transport passes each connection a stable ID and sends the returned
 * messages to their listed destinations.
 */
export class TrackerControlHandler {
  private readonly registry: RoomRegistry;
  private readonly bindings = new Map<ConnectionId, ConnectionBinding>();
  private readonly connectionsByPeer = new Map<PeerId, ConnectionId>();
  private readonly createMessageId: () => string;
  private readonly now: () => number;

  constructor(options: ControlHandlerOptions = {}) {
    this.registry = options.registry ?? new RoomRegistry();
    this.createMessageId = options.createMessageId ?? defaultCreateMessageId;
    this.now = options.now ?? Date.now;
  }

  handle(connectionId: ConnectionId, input: unknown): OutboundControlMessage[] {
    let message: ControlMessage;

    try {
      message =
        typeof input === 'string'
          ? parseControlMessage(input)
          : validateControlMessage(input);
    } catch (error) {
      if (error instanceof ControlValidationError) {
        const code = error.message.includes('message.version')
          ? 'PROTOCOL_VERSION_UNSUPPORTED'
          : 'INVALID_MESSAGE';
        return [
          this.errorForInvalidInput(
            connectionId,
            input,
            code,
            error.message,
          ),
        ];
      }
      throw error;
    }

    try {
      switch (message.type) {
        case 'CREATE_ROOM_REQ':
          return this.createRoom(connectionId, message);
        case 'JOIN_ROOM_REQ':
          return this.joinRoom(connectionId, message);
        case 'CHUNK_HAVE_EVENT':
          this.assertBoundSender(connectionId, message.sessionId, message.senderId);
          this.registry.announceChunk(
            message.sessionId,
            message.senderId,
            message.payload.chunkIndex,
          );
          return [];
        case 'CHUNK_QUERY_REQ': {
          this.assertBoundSender(connectionId, message.sessionId, message.senderId);
          const holderIds = this.registry.getEligibleChunkHolders(
            message.sessionId,
            message.senderId,
            message.payload.chunkIndex,
          );
          return [
            this.toConnection(connectionId, {
              ...this.responseBase('CHUNK_QUERY_RES', message),
              type: 'CHUNK_QUERY_RES',
              payload: { chunkIndex: message.payload.chunkIndex, holderIds },
            }),
          ];
        }
        case 'SIGNAL_SDP':
        case 'SIGNAL_ICE':
          return this.relaySignal(connectionId, message);
        case 'CLOCK_SYNC_REQ':
          return this.handleClockSync(connectionId, message);
        case 'PLAYBACK_SET_REQ':
          return this.setPlayback(connectionId, message);
        case 'PLAYBACK_STATE_REQ':
          return this.getPlayback(connectionId, message);
        default:
          return [
            this.errorForMessage(
              connectionId,
              message,
              'INVALID_MESSAGE',
              `${message.type} is not accepted from clients`,
            ),
          ];
      }
    } catch (error) {
      if (error instanceof HandlerError) {
        return [
          this.errorForMessage(
            connectionId,
            message,
            error.code,
            error.message,
          ),
        ];
      }
      if (error instanceof RoomRegistryError) {
        return [
          this.errorForMessage(
            connectionId,
            message,
            error.code,
            error.message,
          ),
        ];
      }
      throw error;
    }
  }

  disconnect(connectionId: ConnectionId): OutboundControlMessage[] {
    const binding = this.bindings.get(connectionId);
    if (!binding) return [];

    const room = this.registry.getRoom(binding.sessionId);
    const peerIdsBeforeRemoval = room ? [...room.peers.keys()] : [];
    const result = this.registry.removePeer(binding.sessionId, binding.peerId);

    this.unbind(connectionId, binding.peerId);

    if (result.roomClosed) {
      for (const peerId of peerIdsBeforeRemoval) {
        const peerConnectionId = this.connectionsByPeer.get(peerId);
        if (peerConnectionId !== undefined) {
          this.unbind(peerConnectionId, peerId);
        }
      }
      return [];
    }

    return this.topologyUpdates(binding.sessionId, result.affectedPeerIds);
  }

  getBinding(connectionId: ConnectionId): ConnectionBinding | undefined {
    return this.bindings.get(connectionId);
  }

  private createRoom(
    connectionId: ConnectionId,
    request: Extract<ControlMessage, { type: 'CREATE_ROOM_REQ' }>,
  ): OutboundControlMessage[] {
    this.assertUnregistered(connectionId);
    const { peer } = this.registry.createRoom(request.sessionId);
    this.bind(connectionId, request.sessionId, peer.peerId);

    const response: CreateRoomRes = {
      ...this.responseBase('CREATE_ROOM_RES', request),
      type: 'CREATE_ROOM_RES',
      payload: {
        assignedPeerId: peer.peerId,
        topology: peer.topology,
      },
    };
    return [this.toConnection(connectionId, response)];
  }

  private joinRoom(
    connectionId: ConnectionId,
    request: Extract<ControlMessage, { type: 'JOIN_ROOM_REQ' }>,
  ): OutboundControlMessage[] {
    this.assertUnregistered(connectionId);
    const { room, peer, affectedPeerIds } = this.registry.joinRoom(request.sessionId);
    this.bind(connectionId, request.sessionId, peer.peerId);

    const response: JoinRoomRes = {
      ...this.responseBase('JOIN_ROOM_RES', request),
      type: 'JOIN_ROOM_RES',
      payload: {
        assignedPeerId: peer.peerId,
        hostPeerId: room.hostPeerId,
        topology: peer.topology,
      },
    };

    const updates = this.topologyUpdates(
      request.sessionId,
      affectedPeerIds.filter((peerId) => peerId !== peer.peerId),
    );
    return [this.toConnection(connectionId, response), ...updates];
  }

  private relaySignal(
    connectionId: ConnectionId,
    message: Extract<ControlMessage, { type: 'SIGNAL_SDP' | 'SIGNAL_ICE' }>,
  ): OutboundControlMessage[] {
    this.assertBoundSender(connectionId, message.sessionId, message.senderId);
    const targetPeerId = message.payload.targetPeerId;

    if (!this.registry.getPeer(message.sessionId, targetPeerId)) {
      throw new HandlerError('PEER_NOT_FOUND', `Peer ${targetPeerId} does not exist`);
    }
    if (!this.registry.areNeighbors(message.sessionId, message.senderId, targetPeerId)) {
      throw new HandlerError('NOT_NEIGHBOR', 'Signaling is restricted to topology neighbors');
    }

    const targetConnectionId = this.connectionsByPeer.get(targetPeerId);
    if (!targetConnectionId) {
      throw new HandlerError('PEER_NOT_FOUND', `Peer ${targetPeerId} is not connected`);
    }
    return [this.toConnection(targetConnectionId, message)];
  }

  private handleClockSync(
    connectionId: ConnectionId,
    request: Extract<ControlMessage, { type: 'CLOCK_SYNC_REQ' }>,
  ): OutboundControlMessage[] {
    this.assertBoundSender(connectionId, request.sessionId, request.senderId);
    const trackerReceivedAt = this.now();
    const response: ClockSyncRes = {
      ...this.responseBase('CLOCK_SYNC_RES', request),
      type: 'CLOCK_SYNC_RES',
      payload: {
        clientSentAt: request.payload.clientSentAt,
        trackerReceivedAt,
        trackerSentAt: this.now(),
      },
    };
    return [this.toConnection(connectionId, response)];
  }

  private setPlayback(
    connectionId: ConnectionId,
    request: Extract<ControlMessage, { type: 'PLAYBACK_SET_REQ' }>,
  ): OutboundControlMessage[] {
    this.assertBoundSender(connectionId, request.sessionId, request.senderId);
    const state = this.registry.setPlayback(
      request.sessionId,
      request.senderId,
      request.payload,
    );
    const room = this.registry.getRoom(request.sessionId);
    if (!room) return [];

    return [...room.peers.keys()].flatMap((peerId) => {
      const target = this.connectionsByPeer.get(peerId);
      if (!target) return [];
      const event: PlaybackStateEvent = {
        ...this.messageBase('PLAYBACK_STATE_EVENT', request.sessionId),
        type: 'PLAYBACK_STATE_EVENT',
        payload: { state },
      };
      return [this.toConnection(target, event)];
    });
  }

  private getPlayback(
    connectionId: ConnectionId,
    request: Extract<ControlMessage, { type: 'PLAYBACK_STATE_REQ' }>,
  ): OutboundControlMessage[] {
    this.assertBoundSender(connectionId, request.sessionId, request.senderId);
    const room = this.registry.getRoom(request.sessionId);
    if (!room) {
      throw new HandlerError('SESSION_NOT_FOUND', `Session ${request.sessionId} does not exist`);
    }
    const response: PlaybackStateRes = {
      ...this.responseBase('PLAYBACK_STATE_RES', request),
      type: 'PLAYBACK_STATE_RES',
      payload: { state: room.playback },
    };
    return [this.toConnection(connectionId, response)];
  }

  private topologyUpdates(
    sessionId: SessionId,
    peerIds: readonly PeerId[],
  ): OutboundControlMessage[] {
    const messages: OutboundControlMessage[] = [];
    for (const peerId of peerIds) {
      const peer = this.registry.getPeer(sessionId, peerId);
      const connectionId = this.connectionsByPeer.get(peerId);
      if (!peer || !connectionId) continue;

      const event: TopologyUpdateEvent = {
        ...this.messageBase('TOPOLOGY_UPDATE_EVENT', sessionId),
        type: 'TOPOLOGY_UPDATE_EVENT',
        payload: { topology: peer.topology },
      };
      messages.push(this.toConnection(connectionId, event));
    }
    return messages;
  }

  private assertUnregistered(connectionId: ConnectionId): void {
    if (this.bindings.has(connectionId)) {
      throw new HandlerError('INVALID_MESSAGE', 'Connection is already registered');
    }
  }

  private assertBoundSender(
    connectionId: ConnectionId,
    sessionId: SessionId,
    senderId: PeerId,
  ): void {
    const binding = this.bindings.get(connectionId);
    if (
      !binding ||
      binding.sessionId !== sessionId ||
      binding.peerId !== senderId
    ) {
      throw new HandlerError(
        'NOT_REGISTERED',
        'Message identity does not match this connection',
      );
    }
    this.registry.touchPeer(sessionId, senderId);
  }

  private bind(connectionId: ConnectionId, sessionId: SessionId, peerId: PeerId): void {
    this.bindings.set(connectionId, { sessionId, peerId });
    this.connectionsByPeer.set(peerId, connectionId);
  }

  private unbind(connectionId: ConnectionId, peerId: PeerId): void {
    this.bindings.delete(connectionId);
    this.connectionsByPeer.delete(peerId);
  }

  private messageBase<T extends ControlMessage['type']>(type: T, sessionId: SessionId) {
    return {
      version: 1 as const,
      type,
      messageId: this.createMessageId(),
      sessionId,
      timestamp: this.now(),
    };
  }

  private responseBase<T extends ControlMessage['type']>(
    type: T,
    request: ControlMessage,
  ) {
    return {
      ...this.messageBase(type, request.sessionId),
      replyTo: request.messageId,
    };
  }

  private errorForMessage(
    connectionId: ConnectionId,
    request: ControlMessage,
    code: ErrorMessage['payload']['code'],
    message: string,
  ): OutboundControlMessage {
    const error: ErrorMessage = {
      ...this.messageBase('ERROR', request.sessionId),
      type: 'ERROR',
      replyTo: request.messageId,
      payload: { code, message },
    };
    return this.toConnection(connectionId, error);
  }

  private errorForInvalidInput(
    connectionId: ConnectionId,
    input: unknown,
    code: ErrorMessage['payload']['code'],
    message: string,
  ): OutboundControlMessage {
    const partial = readPartialEnvelope(input);
    const binding = this.bindings.get(connectionId);
    const error: ErrorMessage = {
      ...this.messageBase(
        'ERROR',
        binding?.sessionId ?? partial.sessionId ?? 'unregistered',
      ),
      type: 'ERROR',
      ...(partial.messageId ? { replyTo: partial.messageId } : {}),
      payload: { code, message },
    };
    return this.toConnection(connectionId, error);
  }

  private toConnection(
    connectionId: ConnectionId,
    message: ControlMessage,
  ): OutboundControlMessage {
    return { connectionId, message };
  }
}

type HandlerErrorCode =
  | RoomRegistryErrorCode
  | 'INVALID_MESSAGE'
  | 'NOT_REGISTERED'
  | 'NOT_NEIGHBOR'
  | 'INVALID_CHUNK'
  | 'INVALID_PLAYBACK_STATE';

class HandlerError extends Error {
  constructor(
    readonly code: HandlerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

function readPartialEnvelope(input: unknown): {
  sessionId?: string;
  messageId?: string;
} {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.sessionId === 'string' && record.sessionId.length > 0
      ? { sessionId: record.sessionId }
      : {}),
    ...(typeof record.messageId === 'string' && record.messageId.length > 0
      ? { messageId: record.messageId }
      : {}),
  };
}

function defaultCreateMessageId(): string {
  return globalThis.crypto.randomUUID();
}
