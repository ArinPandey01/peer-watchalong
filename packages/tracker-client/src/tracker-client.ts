import type {
  ChunkHaveEvent,
  ChunkQueryReq,
  ChunkQueryRes,
  ClockSyncReq,
  ClockSyncRes,
  ControlMessage,
  CreateRoomReq,
  CreateRoomRes,
  ErrorMessage,
  JoinRoomReq,
  JoinRoomRes,
  PeerId,
  PeerTopology,
  PlaybackSetReq,
  PlaybackState,
  PlaybackStateReq,
  PlaybackStateRes,
  PlaybackUpdate,
  SessionId,
  SignalIce,
  SignalSdp,
} from '../../protocol/control';
import {
  ControlValidationError,
  parseControlMessage,
} from '../../protocol/control-validator';

const OPEN = 1;
const CONNECTING = 0;

type ResponseMessage =
  | CreateRoomRes
  | JoinRoomRes
  | ChunkQueryRes
  | ClockSyncRes
  | PlaybackStateRes;

interface ResponseByType {
  CREATE_ROOM_RES: CreateRoomRes;
  JOIN_ROOM_RES: JoinRoomRes;
  CHUNK_QUERY_RES: ChunkQueryRes;
  CLOCK_SYNC_RES: ClockSyncRes;
  PLAYBACK_STATE_RES: PlaybackStateRes;
}

interface PendingRequest {
  expectedType: ResponseMessage['type'];
  resolve: (message: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TrackerCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface TrackerClientEvents {
  open: undefined;
  close: TrackerCloseEvent;
  topology: PeerTopology;
  playback: PlaybackState;
  signalSdp: SignalSdp;
  signalIce: SignalIce;
  error: ErrorMessage;
  protocolError: Error;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TrackerClientOptions {
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  createMessageId?: () => string;
  now?: () => number;
  createWebSocket?: (url: string) => WebSocketLike;
}

export type ClockSyncSample = ClockSyncRes['payload'] & {
  clientReceivedAt: number;
};

export class TrackerRequestError extends Error {
  constructor(
    readonly code: ErrorMessage['payload']['code'],
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'TrackerRequestError';
  }
}

export class TrackerClient {
  private readonly requestTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly createMessageId: () => string;
  private readonly now: () => number;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<
    keyof TrackerClientEvents,
    Set<(payload: TrackerClientEvents[keyof TrackerClientEvents]) => void>
  >();

  private socket: WebSocketLike | null = null;
  private connectionPromise: Promise<void> | null = null;
  private sessionId: SessionId | null = null;
  private peerId: PeerId | null = null;
  private registrationInFlight = false;

  constructor(
    readonly url: string,
    options: TrackerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    this.createMessageId = options.createMessageId ?? defaultCreateMessageId;
    this.now = options.now ?? Date.now;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;

    assertPositiveInteger(this.requestTimeoutMs, 'requestTimeoutMs');
    assertPositiveInteger(this.connectionTimeoutMs, 'connectionTimeoutMs');
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  get identity(): { sessionId: SessionId; peerId: PeerId } | null {
    return this.sessionId && this.peerId
      ? { sessionId: this.sessionId, peerId: this.peerId }
      : null;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.createWebSocket(this.url);
      } catch (error) {
        this.connectionPromise = null;
        reject(asError(error));
        return;
      }

      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.close(1000, 'Connection timed out');
        reject(new Error('Tracker connection timed out'));
      }, this.connectionTimeoutMs);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.connectionPromise = null;
        this.emit('open', undefined);
        resolve();
      };
      socket.onerror = () => {
        if (socket.readyState === CONNECTING) {
          clearTimeout(timeout);
          this.connectionPromise = null;
          reject(new Error('Unable to connect to tracker'));
        }
      };
      socket.onmessage = (event) => this.receive(event.data);
      socket.onclose = (event) => {
        clearTimeout(timeout);
        this.connectionPromise = null;
        if (this.socket === socket) this.socket = null;
        this.clearIdentity();
        this.rejectPending(new Error('Tracker connection closed'));
        this.emit('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      };
    });

    return this.connectionPromise;
  }

  disconnect(code = 1000, reason = 'Client disconnected'): void {
    this.socket?.close(code, reason);
  }

  on<K extends keyof TrackerClientEvents>(
    type: K,
    listener: (payload: TrackerClientEvents[K]) => void,
  ): () => void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }

    const wrapped = (payload: TrackerClientEvents[keyof TrackerClientEvents]) => {
      listener(payload as TrackerClientEvents[K]);
    };
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  }

  async createRoom(sessionId: SessionId): Promise<CreateRoomRes> {
    this.assertCanRegister();
    this.registrationInFlight = true;
    try {
      const request: CreateRoomReq = {
        ...this.base('CREATE_ROOM_REQ', sessionId),
        type: 'CREATE_ROOM_REQ',
        payload: {},
      };
      const response = await this.request(request, 'CREATE_ROOM_RES');
      this.sessionId = sessionId;
      this.peerId = response.payload.assignedPeerId;
      this.emit('topology', response.payload.topology);
      return response;
    } finally {
      this.registrationInFlight = false;
    }
  }

  async joinRoom(sessionId: SessionId): Promise<JoinRoomRes> {
    this.assertCanRegister();
    this.registrationInFlight = true;
    try {
      const request: JoinRoomReq = {
        ...this.base('JOIN_ROOM_REQ', sessionId),
        type: 'JOIN_ROOM_REQ',
        payload: {},
      };
      const response = await this.request(request, 'JOIN_ROOM_RES');
      this.sessionId = sessionId;
      this.peerId = response.payload.assignedPeerId;
      this.emit('topology', response.payload.topology);
      return response;
    } finally {
      this.registrationInFlight = false;
    }
  }

  announceChunk(chunkIndex: number): void {
    const identity = this.requireIdentity();
    const event: ChunkHaveEvent = {
      ...this.peerBase('CHUNK_HAVE_EVENT', identity),
      type: 'CHUNK_HAVE_EVENT',
      payload: { chunkIndex },
    };
    this.send(event);
  }

  queryChunk(chunkIndex: number): Promise<ChunkQueryRes> {
    const identity = this.requireIdentity();
    const request: ChunkQueryReq = {
      ...this.peerBase('CHUNK_QUERY_REQ', identity),
      type: 'CHUNK_QUERY_REQ',
      payload: { chunkIndex },
    };
    return this.request(request, 'CHUNK_QUERY_RES');
  }

  sendSdp(
    targetPeerId: PeerId,
    description: SignalSdp['payload']['description'],
  ): void {
    const identity = this.requireIdentity();
    const message: SignalSdp = {
      ...this.peerBase('SIGNAL_SDP', identity),
      type: 'SIGNAL_SDP',
      payload: { targetPeerId, description },
    };
    this.send(message);
  }

  sendIce(
    targetPeerId: PeerId,
    candidate: SignalIce['payload']['candidate'],
  ): void {
    const identity = this.requireIdentity();
    const message: SignalIce = {
      ...this.peerBase('SIGNAL_ICE', identity),
      type: 'SIGNAL_ICE',
      payload: { targetPeerId, candidate },
    };
    this.send(message);
  }

  async syncClock(): Promise<ClockSyncSample> {
    const identity = this.requireIdentity();
    const clientSentAt = this.now();
    const request: ClockSyncReq = {
      ...this.peerBase('CLOCK_SYNC_REQ', identity),
      type: 'CLOCK_SYNC_REQ',
      payload: { clientSentAt },
    };
    const response = await this.request(request, 'CLOCK_SYNC_RES');
    return { ...response.payload, clientReceivedAt: this.now() };
  }

  setPlayback(update: PlaybackUpdate): void {
    const identity = this.requireIdentity();
    const request: PlaybackSetReq = {
      ...this.peerBase('PLAYBACK_SET_REQ', identity),
      type: 'PLAYBACK_SET_REQ',
      payload: update,
    };
    this.send(request);
  }

  requestPlaybackState(): Promise<PlaybackStateRes> {
    const identity = this.requireIdentity();
    const request: PlaybackStateReq = {
      ...this.peerBase('PLAYBACK_STATE_REQ', identity),
      type: 'PLAYBACK_STATE_REQ',
      payload: {},
    };
    return this.request(request, 'PLAYBACK_STATE_RES');
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      const error = new Error('Tracker control message must be JSON text');
      this.emit('protocolError', error);
      this.socket?.close(1003, error.message);
      return;
    }

    let message: ControlMessage;
    try {
      message = parseControlMessage(data);
    } catch (error) {
      const validationError =
        error instanceof ControlValidationError ? error : asError(error);
      this.emit('protocolError', validationError);
      return;
    }

    if (message.type === 'ERROR') {
      this.handleError(message);
      return;
    }

    if ('replyTo' in message) {
      this.resolveRequest(message);
      return;
    }

    switch (message.type) {
      case 'TOPOLOGY_UPDATE_EVENT':
        this.emit('topology', message.payload.topology);
        break;
      case 'PLAYBACK_STATE_EVENT':
        this.emit('playback', message.payload.state);
        break;
      case 'SIGNAL_SDP':
        this.emit('signalSdp', message);
        break;
      case 'SIGNAL_ICE':
        this.emit('signalIce', message);
        break;
      default:
        this.emit(
          'protocolError',
          new Error(`Unexpected tracker message: ${message.type}`),
        );
    }
  }

  private request<K extends keyof ResponseByType>(
    message: ControlMessage,
    expectedType: K,
  ): Promise<ResponseByType[K]> {
    this.assertConnected();

    return new Promise<ResponseByType[K]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(message.messageId);
        reject(new Error(`Tracker request timed out: ${message.type}`));
      }, this.requestTimeoutMs);

      this.pending.set(message.messageId, {
        expectedType,
        resolve: (response) => resolve(response as ResponseByType[K]),
        reject,
        timeout,
      });

      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(message.messageId);
        reject(asError(error));
      }
    });
  }

  private resolveRequest(message: ResponseMessage): void {
    const pending = this.pending.get(message.replyTo);
    if (!pending) return;
    if (message.type !== pending.expectedType) {
      clearTimeout(pending.timeout);
      this.pending.delete(message.replyTo);
      pending.reject(
        new Error(
          `Expected ${pending.expectedType}, received ${message.type}`,
        ),
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.replyTo);
    pending.resolve(message);
  }

  private handleError(message: ErrorMessage): void {
    this.emit('error', message);
    if (!message.replyTo) return;

    const pending = this.pending.get(message.replyTo);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.replyTo);
    pending.reject(
      new TrackerRequestError(
        message.payload.code,
        message.payload.message,
        message.replyTo,
      ),
    );
  }

  private send(message: ControlMessage): void {
    this.assertConnected();
    this.socket?.send(JSON.stringify(message));
  }

  private base<T extends ControlMessage['type']>(type: T, sessionId: SessionId) {
    return {
      version: 1 as const,
      type,
      messageId: this.createMessageId(),
      sessionId,
      timestamp: this.now(),
    };
  }

  private peerBase<T extends ControlMessage['type']>(
    type: T,
    identity: { sessionId: SessionId; peerId: PeerId },
  ) {
    return {
      ...this.base(type, identity.sessionId),
      senderId: identity.peerId,
    };
  }

  private emit<K extends keyof TrackerClientEvents>(
    type: K,
    payload: TrackerClientEvents[K],
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  private assertCanRegister(): void {
    this.assertConnected();
    if (this.identity || this.registrationInFlight) {
      throw new Error('Tracker connection is already registered or registering');
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('Tracker is not connected');
  }

  private requireIdentity(): { sessionId: SessionId; peerId: PeerId } {
    const identity = this.identity;
    if (!identity) throw new Error('Tracker connection is not registered');
    return identity;
  }

  private clearIdentity(): void {
    this.sessionId = null;
    this.peerId = null;
    this.registrationInFlight = false;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  return new WebSocket(url);
}

function defaultCreateMessageId(): string {
  return globalThis.crypto.randomUUID();
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
