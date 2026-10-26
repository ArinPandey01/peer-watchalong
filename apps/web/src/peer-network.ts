import {
  WebRtcPeer,
  type WebRtcPeerOptions,
} from '@peer-watchalong/webrtc';
import type {
  TrackerClient,
  TrackerClientEvents,
} from '@peer-watchalong/tracker-client';

type TrackerLink = Pick<
  TrackerClient,
  'identity' | 'on' | 'sendSdp' | 'sendIce'
>;
type PeerSession = Pick<
  WebRtcPeer,
  'start' | 'handleRemoteDescription' | 'handleRemoteIceCandidate' |
  'send' | 'close'
>;

export interface PeerNetworkOptions {
  createPeer?: (options: WebRtcPeerOptions) => PeerSession;
  onMessage?: (peerId: string, data: Uint8Array) => void;
  onConnectedCount?: (count: number) => void;
  onError?: (error: Error) => void;
}

export class RoomPeerNetwork {
  private readonly client: TrackerLink;
  private readonly options: PeerNetworkOptions;
  private readonly createPeer: (options: WebRtcPeerOptions) => PeerSession;
  private readonly peers = new Map<string, PeerSession>();
  private readonly openChannels = new Set<string>();
  private lastTopology: TrackerClientEvents['topology'] | null = null;
  private subscriptions: Array<() => void> = [];
  private closed = false;

  constructor(client: TrackerLink, options: PeerNetworkOptions = {}) {
    this.client = client;
    this.options = options;
    this.createPeer = options.createPeer ?? ((peerOptions) => new WebRtcPeer(peerOptions));
  }

  start(): void {
    if (this.closed || this.subscriptions.length > 0) return;
    this.subscriptions = [
      this.client.on('topology', (topology) => this.applyTopology(topology)),
      this.client.on('hostReconnected', (hostPeerId) => {
        const peer = this.peers.get(hostPeerId);
        if (peer) {
          peer.close();
          this.peers.delete(hostPeerId);
          this.openChannels.delete(hostPeerId);
        }
        const topology = this.lastTopology;
        if (topology) this.applyTopology(topology);
      }),
      this.client.on('signalSdp', (signal) => {
        const peer = this.peers.get(signal.senderId);
        if (!peer) return;
        void peer.handleRemoteDescription(signal.payload.description).catch(
          (error: unknown) => this.reportError(error),
        );
      }),
      this.client.on('signalIce', (signal) => {
        const peer = this.peers.get(signal.senderId);
        if (!peer) return;
        void peer.handleRemoteIceCandidate(signal.payload.candidate).catch(
          (error: unknown) => this.reportError(error),
        );
      }),
    ];
  }

  send(peerId: string, data: Uint8Array): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || this.closed) {
      return Promise.reject(new Error(`Peer ${peerId} is not connected to this room`));
    }
    return peer.send(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.openChannels.clear();
    this.options.onConnectedCount?.(0);
  }

  private applyTopology(topology: TrackerClientEvents['topology']): void {
    this.lastTopology = topology;
    const self = this.client.identity?.peerId;
    if (!self || this.closed) return;
    const authorized = new Set([
      ...topology.parents,
      ...topology.children,
      ...topology.siblings,
    ]);
    authorized.delete(self);

    for (const [peerId, peer] of this.peers) {
      if (authorized.has(peerId)) continue;
      peer.close();
      this.peers.delete(peerId);
      this.openChannels.delete(peerId);
    }
    this.options.onConnectedCount?.(this.openChannels.size);

    for (const peerId of authorized) {
      if (this.peers.has(peerId)) continue;
      try {
        const peer = this.createPeer({
          initiator: self < peerId,
          polite: self > peerId,
          sendDescription: (description) => this.client.sendSdp(peerId, description),
          sendIceCandidate: (candidate) => this.client.sendIce(peerId, candidate),
          onMessage: (data) => this.options.onMessage?.(peerId, data),
          onDataChannelStateChange: (state) => {
            if (this.peers.get(peerId) !== peer) return;
            if (state === 'open') this.openChannels.add(peerId);
            else this.openChannels.delete(peerId);
            this.options.onConnectedCount?.(this.openChannels.size);
          },
          onError: (error) => this.reportError(error),
        });
        this.peers.set(peerId, peer);
        try {
          peer.start();
        } catch (error) {
          this.peers.delete(peerId);
          peer.close();
          throw error;
        }
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    if (!this.closed) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
