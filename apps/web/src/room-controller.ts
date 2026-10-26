import {
  TrackerRequestError,
  type TrackerClient,
  type TrackerClientEvents,
} from '@peer-watchalong/tracker-client';
import { generateRoomCode, normalizeRoomCode } from './room-code.ts';
import { RoomPeerNetwork } from './peer-network.ts';
import { ChunkExchange } from './chunk-exchange.ts';
import type { ChunkNotAvailable, ChunkPayload } from '@peer-watchalong/protocol';
import type { MediaManifest } from '@peer-watchalong/protocol';
import {
  ClockSynchronizer,
  PlaybackSynchronizer,
  getTargetMediaTimeSec,
  type PlaybackDecision,
} from '@peer-watchalong/scheduler';
import { ViewerChunkLoader } from './viewer-chunks.ts';

type Role = 'host' | 'viewer';
type TrackerConnection = Pick<
  TrackerClient,
  'connect' | 'createRoom' | 'resumeHost' | 'joinRoom' | 'disconnect' | 'on' |
  'setPlayback' | 'requestPlaybackState' | 'identity' | 'sendSdp' | 'sendIce'
  | 'setMedia' | 'requestMedia'
  | 'announceChunk' | 'queryChunk'
  | 'syncClock'
>;
type PlaybackState = TrackerClientEvents['playback'];
type PlaybackUpdate = Parameters<TrackerClient['setPlayback']>[0];
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const VIEWER_ROOM_KEY = 'peer-watchalong.viewer-room';
const HOST_ROOM_KEY = 'peer-watchalong.host-room';

export type RoomView =
  | { screen: 'home'; error?: string; enteredCode?: string }
  | { screen: 'connecting'; role: Role; code: string }
  | {
      screen: 'room';
      role: Role;
      code: string;
      connection: 'connected' | 'disconnected';
    }
  | { screen: 'ended'; code: string; reason: string };

export class RoomController {
  private state: RoomView = { screen: 'home' };
  private readonly listeners = new Set<(state: RoomView) => void>();
  private readonly playbackListeners = new Set<(state: PlaybackState | null) => void>();
  private readonly mediaListeners = new Set<(manifest: MediaManifest | null) => void>();
  private readonly peerCountListeners = new Set<(count: number) => void>();
  private readonly peerDataListeners = new Set<(peerId: string, data: Uint8Array) => void>();
  private readonly chunkListeners = new Set<(
    peerId: string,
    result: ChunkPayload | ChunkNotAvailable,
  ) => void>();
  private readonly createClient: () => TrackerConnection;
  private readonly createCode: () => string;
  private readonly sessionStore: SessionStore | null;
  private resumedHost = false;
  private client: TrackerConnection | null = null;
  private subscriptions: Array<() => void> = [];
  private playback: PlaybackState | null = null;
  private media: MediaManifest | null = null;
  private peerNetwork: RoomPeerNetwork | null = null;
  private chunkExchange: ChunkExchange | null = null;
  private readChunk: (chunkIndex: number) => Uint8Array | null | Promise<Uint8Array | null> =
    () => null;
  private peerCount = 0;
  private mediaPublishSequence = 0;
  private viewerLoader: ViewerChunkLoader | null = null;
  private clock: ClockSynchronizer | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private downloadTimer: ReturnType<typeof setInterval> | null = null;
  private readonly chunkProgressListeners = new Set<(downloaded: number, total: number) => void>();
  private readonly verifiedChunkListeners = new Set<(chunkIndex: number, data: Uint8Array) => void>();
  private chunkProgress = { downloaded: 0, total: 0 };
  private playbackSynchronizer: PlaybackSynchronizer | null = null;

  constructor(
    createClient: () => TrackerConnection,
    createCode: () => string = generateRoomCode,
    sessionStore: SessionStore | null = browserSessionStore(),
  ) {
    this.createClient = createClient;
    this.createCode = createCode;
    this.sessionStore = sessionStore;
  }

  get current(): RoomView {
    return this.state;
  }

  get currentPlayback(): PlaybackState | null {
    return this.playback;
  }

  get hostWasResumed(): boolean {
    return this.resumedHost;
  }

  get currentMedia(): MediaManifest | null {
    return this.media;
  }

  get connectedPeerCount(): number {
    return this.peerCount;
  }

  get currentChunkProgress(): { downloaded: number; total: number } {
    return { ...this.chunkProgress };
  }

  evaluateViewerPlayback(localMediaTimeSec: number): PlaybackDecision {
    return this.playbackSynchronizer?.evaluate(localMediaTimeSec, Date.now()) ??
      { type: 'WAIT_FOR_STATE' };
  }

  readCachedChunk(chunkIndex: number): Uint8Array | null {
    return this.viewerLoader?.readChunk(chunkIndex) ?? null;
  }

  subscribe(listener: (state: RoomView) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribePlayback(listener: (state: PlaybackState | null) => void): () => void {
    this.playbackListeners.add(listener);
    listener(this.playback);
    return () => this.playbackListeners.delete(listener);
  }

  subscribeMedia(listener: (manifest: MediaManifest | null) => void): () => void {
    this.mediaListeners.add(listener);
    listener(this.media);
    return () => this.mediaListeners.delete(listener);
  }

  subscribePeerCount(listener: (count: number) => void): () => void {
    this.peerCountListeners.add(listener);
    listener(this.peerCount);
    return () => this.peerCountListeners.delete(listener);
  }

  subscribePeerData(listener: (peerId: string, data: Uint8Array) => void): () => void {
    this.peerDataListeners.add(listener);
    return () => this.peerDataListeners.delete(listener);
  }

  subscribeChunkResults(listener: (
    peerId: string,
    result: ChunkPayload | ChunkNotAvailable,
  ) => void): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  subscribeChunkProgress(listener: (downloaded: number, total: number) => void): () => void {
    this.chunkProgressListeners.add(listener);
    listener(this.chunkProgress.downloaded, this.chunkProgress.total);
    return () => this.chunkProgressListeners.delete(listener);
  }

  subscribeVerifiedChunks(listener: (chunkIndex: number, data: Uint8Array) => void): () => void {
    this.verifiedChunkListeners.add(listener);
    return () => this.verifiedChunkListeners.delete(listener);
  }

  setChunkReader(reader: (chunkIndex: number) =>
    Uint8Array | null | Promise<Uint8Array | null>): void {
    this.readChunk = reader;
  }

  requestChunk(peerId: string, chunkIndex: number, requestId: number): Promise<void> {
    if (!this.chunkExchange) {
      return Promise.reject(new Error('Not connected to a room'));
    }
    return this.chunkExchange.request(peerId, chunkIndex, requestId);
  }

  sendPeerData(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.peerNetwork || this.state.screen !== 'room') {
      return Promise.reject(new Error('Not connected to a room'));
    }
    return this.peerNetwork.send(peerId, data);
  }

  publishPlayback(update: PlaybackUpdate): boolean {
    if (this.state.screen !== 'room' || this.state.role !== 'host' || !this.client) {
      return false;
    }
    try {
      this.client.setPlayback(update);
      return true;
    } catch {
      return false;
    }
  }

  async publishMedia(manifest: MediaManifest | null): Promise<void> {
    if (this.state.screen !== 'room' || this.state.role !== 'host' || !this.client) {
      throw new Error('Only the room host can share media');
    }
    const client = this.client;
    const sequence = ++this.mediaPublishSequence;
    await client.setMedia(manifest);
    if (this.client !== client || sequence !== this.mediaPublishSequence || !manifest) return;
    for (const chunk of manifest.chunks) {
      client.announceChunk(manifest.mediaId, chunk.chunkIndex);
    }
  }

  queryChunkHolders(mediaId: string, chunkIndex: number): ReturnType<TrackerClient['queryChunk']> {
    if (this.state.screen !== 'room' || this.state.role !== 'viewer' || !this.client ||
        this.media?.mediaId !== mediaId) {
      return Promise.reject(new Error('This video is no longer available'));
    }
    return this.client.queryChunk(mediaId, chunkIndex);
  }

  announceCachedChunk(mediaId: string, chunkIndex: number): void {
    if (this.state.screen === 'room' && this.state.role === 'viewer' &&
        this.media?.mediaId === mediaId) {
      this.client?.announceChunk(mediaId, chunkIndex);
    }
  }

  async createRoom(): Promise<void> {
    if (this.state.screen === 'connecting') return;
    this.clearViewerSession();
    this.clearHostSession();
    await this.start('host', this.createCode());
  }

  async restoreSession(): Promise<void> {
    if (this.state.screen !== 'home') return;
    const host = this.savedHostSession();
    if (host) {
      await this.start('host', host.code, host.token);
      return;
    }
    const code = this.savedViewerCode();
    if (code) await this.start('viewer', code);
  }

  async joinRoom(enteredCode: string): Promise<void> {
    if (this.state.screen === 'connecting') return;
    const code = normalizeRoomCode(enteredCode);
    if (!code) {
      this.setState({
        screen: 'home',
        error: 'Enter an eight-character room code.',
        enteredCode,
      });
      return;
    }
    this.saveViewerCode(code);
    this.clearHostSession();
    await this.start('viewer', code);
  }

  async retry(): Promise<void> {
    if (this.state.screen !== 'room' || this.state.connection !== 'disconnected') return;
    if (this.state.role === 'host') {
      const saved = this.savedHostSession();
      if (saved?.code === this.state.code) await this.start('host', saved.code, saved.token);
    } else {
      await this.start('viewer', this.state.code);
    }
  }

  leave(): void {
    this.clearViewerSession();
    this.clearHostSession();
    this.releaseClient(true);
    this.setState({ screen: 'home' });
  }

  private async start(role: Role, initialCode: string, resumeToken?: string): Promise<void> {
    this.releaseClient();
    this.resumedHost = false;
    const client = this.createClient();
    this.client = client;
    const exchange = new ChunkExchange({
      readChunk: (chunkIndex) => this.readChunk(chunkIndex),
      send: (peerId, packet) => this.sendPeerData(peerId, packet),
      onResult: (peerId, result) => {
        if (this.client !== client) return;
        void this.viewerLoader?.receive(peerId, result);
        for (const listener of this.chunkListeners) listener(peerId, result);
      },
      onFragment: (peerId, chunkIndex, requestId) => {
        if (this.client === client) {
          this.viewerLoader?.receiveFragment(peerId, chunkIndex, requestId);
        }
      },
      onError: (error) => {
        if (this.client === client) console.error('Chunk exchange error', error);
      },
    });
    this.chunkExchange = exchange;
    this.peerNetwork = new RoomPeerNetwork(client, {
      onConnectedCount: (count) => {
        if (this.client === client) this.setPeerCount(count);
      },
      onMessage: (peerId, data) => {
        if (this.client !== client) return;
        void exchange.receive(peerId, data);
        for (const listener of this.peerDataListeners) listener(peerId, data);
      },
      onError: (error) => {
        if (this.client === client) console.error('Peer connection error', error);
      },
    });
    this.peerNetwork.start();
    let code = initialCode;
    this.subscriptions = [
      client.on('roomClosed', () => {
        if (this.client !== client) return;
        this.clearViewerSession();
        this.clearHostSession();
        this.releaseClient();
        this.setState({
          screen: 'ended',
          code,
          reason: 'The host left. This room has ended.',
        });
      }),
      client.on('close', () => {
        if (this.client !== client) return;
        if (this.state.screen !== 'room') return;
        this.releaseClient();
        this.setState({ screen: 'room', role, code, connection: 'disconnected' });
      }),
      client.on('playback', (state) => {
        if (this.client === client) this.setPlaybackState(state);
      }),
      client.on('media', (manifest) => {
        if (this.client === client) this.setMedia(manifest);
      }),
    ];
    this.setState({ screen: 'connecting', role, code });

    try {
      await client.connect();
      if (this.client !== client) return;
      if (role === 'host') {
        if (resumeToken) {
          await client.resumeHost(code, resumeToken);
          if (this.client !== client) return;
          this.resumedHost = true;
          const playback = await client.requestPlaybackState();
          if (this.client !== client) return;
          this.setPlaybackState(playback.payload.state);
        } else {
          let registered = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await client.createRoom(code);
              this.saveHostSession(code, response.payload.resumeToken);
              registered = true;
              break;
            } catch (error) {
              if (
                !(error instanceof TrackerRequestError) ||
                error.code !== 'SESSION_ALREADY_EXISTS' ||
                attempt === 2
              ) throw error;
              code = this.createCode();
              this.setState({ screen: 'connecting', role, code });
            }
          }
          if (!registered) return;
        }
      } else {
        await client.joinRoom(code);
      }
      if (this.client === client) {
        this.setState({ screen: 'room', role, code, connection: 'connected' });
        if (role === 'viewer') {
          this.clock = new ClockSynchronizer();
          this.playbackSynchronizer = new PlaybackSynchronizer(this.clock);
          if (this.playback) this.playbackSynchronizer.applyPlaybackState(this.playback);
          this.configureViewerLoader();
          const syncClock = () => {
            void client.syncClock().then((sample) => {
              if (this.client !== client) return;
              this.clock?.addSample(sample, sample.clientReceivedAt);
              this.updateViewerDownloads();
            }).catch(() => {});
          };
          syncClock();
          this.clockTimer = setInterval(syncClock, 10_000);
          this.downloadTimer = setInterval(() => {
            this.updateViewerDownloads();
            this.viewerLoader?.tick();
          }, 250);
          void client.requestMedia().then((response) => {
            if (this.client === client && response.payload.manifest) {
              this.setMedia(response.payload.manifest);
            }
          }).catch(() => {});
          void client.requestPlaybackState().then((response) => {
            if (this.client === client) this.setPlaybackState(response.payload.state);
          }).catch(() => {});
        }
      }
    } catch (error) {
      if (this.client !== client) return;
      if (role === 'viewer' && error instanceof TrackerRequestError &&
          (error.code === 'SESSION_NOT_FOUND' || error.code === 'SESSION_FULL')) {
        this.clearViewerSession();
      }
      if (role === 'host' && resumeToken && error instanceof TrackerRequestError &&
          (error.code === 'SESSION_NOT_FOUND' || error.code === 'INVALID_RESUME_TOKEN')) {
        this.clearHostSession();
      }
      this.releaseClient();
      this.setState({
        screen: 'home',
        error: describeError(error, role),
        ...(role === 'viewer' ? { enteredCode: code } : {}),
      });
    }
  }

  private releaseClient(explicitLeave = false): void {
    const client = this.client;
    this.client = null;
    this.mediaPublishSequence++;
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.downloadTimer) clearInterval(this.downloadTimer);
    this.clockTimer = null;
    this.downloadTimer = null;
    this.clock = null;
    this.playbackSynchronizer = null;
    this.viewerLoader?.close();
    this.viewerLoader = null;
    this.setChunkProgress(0, 0);
    this.peerNetwork?.close();
    this.peerNetwork = null;
    this.chunkExchange?.close();
    this.chunkExchange = null;
    this.readChunk = () => null;
    this.setPeerCount(0);
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    client?.disconnect(1000, explicitLeave ? 'Leave room' : 'Client disconnected');
    this.setPlaybackState(null);
    this.setMedia(null);
  }

  private setPeerCount(count: number): void {
    if (this.peerCount === count) return;
    this.peerCount = count;
    for (const listener of this.peerCountListeners) listener(count);
  }

  private setPlaybackState(state: PlaybackState | null): void {
    if (state && this.playback &&
        (state.revision < this.playback.revision ||
          (state.revision === this.playback.revision &&
            state.effectiveAt < this.playback.effectiveAt))) {
      return;
    }
    this.playback = state;
    if (state) this.playbackSynchronizer?.applyPlaybackState(state);
    for (const listener of this.playbackListeners) listener(state);
    this.updateViewerDownloads();
  }

  private setMedia(manifest: MediaManifest | null): void {
    if (manifest?.mediaId === this.media?.mediaId) {
      if (!manifest) return;
      this.media = manifest;
      this.viewerLoader?.updateManifest(manifest);
      for (const listener of this.mediaListeners) listener(manifest);
      this.updateViewerDownloads();
      return;
    }
    this.media = manifest;
    this.configureViewerLoader();
    for (const listener of this.mediaListeners) listener(manifest);
  }

  private configureViewerLoader(): void {
    if (this.state.screen !== 'room' || this.state.role !== 'viewer') return;
    this.viewerLoader?.close();
    this.viewerLoader = null;
    this.readChunk = () => null;
    this.setChunkProgress(0, this.media?.chunks.length ?? 0);
    const manifest = this.media;
    if (!manifest) return;
    const loader = new ViewerChunkLoader({
      manifest,
      queryHolders: (chunkIndex) => this.queryChunkHolders(manifest.mediaId, chunkIndex)
        .then((response) => response.payload.mediaId === manifest.mediaId
          ? response.payload.holderIds : []),
      requestChunk: (peerId, chunkIndex, requestId) =>
        this.requestChunk(peerId, chunkIndex, requestId),
      announceChunk: (chunkIndex) => this.announceCachedChunk(manifest.mediaId, chunkIndex),
      onProgress: (downloaded, total) => this.setChunkProgress(downloaded, total),
      onChunk: (chunkIndex, data) => {
        if (this.viewerLoader !== loader) return;
        for (const listener of this.verifiedChunkListeners) listener(chunkIndex, data);
      },
      onError: (error) => console.error('Viewer chunk error', error),
    });
    this.viewerLoader = loader;
    this.readChunk = (chunkIndex) => loader.readChunk(chunkIndex);
    this.updateViewerDownloads();
  }

  private updateViewerDownloads(): void {
    if (!this.viewerLoader || !this.media) return;
    const trackerTime = this.clock?.getTrackerTimeMs(Date.now()) ?? null;
    const target = this.playback
      ? getTargetMediaTimeSec(this.playback, trackerTime ?? this.playback.effectiveAt)
      : 0;
    this.viewerLoader.updateTarget(target, this.playback?.revision ?? 0);
  }

  private setChunkProgress(downloaded: number, total: number): void {
    if (this.chunkProgress.downloaded === downloaded && this.chunkProgress.total === total) return;
    this.chunkProgress = { downloaded, total };
    for (const listener of this.chunkProgressListeners) listener(downloaded, total);
  }

  private setState(state: RoomView): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private savedViewerCode(): string | null {
    try {
      const saved = this.sessionStore?.getItem(VIEWER_ROOM_KEY);
      const code = saved ? normalizeRoomCode(saved) : null;
      if (saved && !code) this.clearViewerSession();
      return code;
    } catch {
      return null;
    }
  }

  private saveViewerCode(code: string): void {
    try {
      this.sessionStore?.setItem(VIEWER_ROOM_KEY, code);
    } catch {}
  }

  private clearViewerSession(): void {
    try {
      this.sessionStore?.removeItem(VIEWER_ROOM_KEY);
    } catch {}
  }

  private savedHostSession(): { code: string; token: string } | null {
    try {
      const saved = this.sessionStore?.getItem(HOST_ROOM_KEY);
      if (!saved) return null;
      const value: unknown = JSON.parse(saved);
      if (typeof value !== 'object' || value === null) return null;
      const { code, token } = value as { code?: unknown; token?: unknown };
      const normalized = typeof code === 'string' ? normalizeRoomCode(code) : null;
      if (!normalized || typeof token !== 'string' || !token) return null;
      return { code: normalized, token };
    } catch {
      return null;
    }
  }

  private saveHostSession(code: string, token: string): void {
    try {
      this.sessionStore?.setItem(HOST_ROOM_KEY, JSON.stringify({ code, token }));
    } catch {}
  }

  private clearHostSession(): void {
    try {
      this.sessionStore?.removeItem(HOST_ROOM_KEY);
    } catch {}
  }
}

function browserSessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function describeError(error: unknown, role: Role): string {
  if (error instanceof TrackerRequestError) {
    switch (error.code) {
      case 'SESSION_NOT_FOUND':
        return 'No room was found with that code.';
      case 'SESSION_FULL':
        return 'This room is full.';
      case 'SESSION_ALREADY_EXISTS':
        return 'Could not make a unique room code. Try again.';
      default:
        return role === 'host'
          ? 'Could not create the room. Try again.'
          : 'Could not join the room. Try again.';
    }
  }
  return 'Could not reach the tracker. Check the connection and try again.';
}
