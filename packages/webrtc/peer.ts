import {
  BufferedDataChannel,
  type BufferedDataChannelOptions,
  type DataChannelState,
} from './data-channel';
import {
  PeerConnectionController,
  type PeerConnectionErrorContext,
  type SignalDescription,
  type SignalIceCandidate,
} from './peer-connection';

export type WebRtcPeerErrorContext =
  | PeerConnectionErrorContext
  | 'remote-description'
  | 'remote-candidate'
  | 'data-channel-send';

export interface WebRtcPeerOptions {
  initiator: boolean;
  polite: boolean;
  configuration?: RTCConfiguration;
  channelLabel?: string;
  dataChannel?: Pick<
    BufferedDataChannelOptions,
    'highWaterMark' | 'lowWaterMark' | 'maxMessageSize'
  >;
  createPeerConnection?: (
    configuration: RTCConfiguration | undefined,
  ) => RTCPeerConnection;
  sendDescription: (
    description: SignalDescription,
  ) => void | Promise<void>;
  sendIceCandidate: (
    candidate: SignalIceCandidate,
  ) => void | Promise<void>;
  onMessage?: (data: Uint8Array) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onDataChannelStateChange?: (state: DataChannelState) => void;
  onError?: (error: Error, context: WebRtcPeerErrorContext) => void;
}

/**
 * Composes signaling and backpressured binary transfer for one authorized
 * neighbor. Room membership, authorization, and retry policy stay outside
 * this package.
 */
export class WebRtcPeer {
  private readonly options: WebRtcPeerOptions;
  private readonly controller: PeerConnectionController;
  private dataChannel: BufferedDataChannel | undefined;
  private closed = false;

  constructor(options: WebRtcPeerOptions) {
    this.options = options;
    this.controller = new PeerConnectionController({
      initiator: options.initiator,
      polite: options.polite,
      configuration: options.configuration,
      channelLabel: options.channelLabel,
      createPeerConnection: options.createPeerConnection,
      onDescription: options.sendDescription,
      onIceCandidate: options.sendIceCandidate,
      onDataChannel: (channel) => this.attachDataChannel(channel),
      onConnectionStateChange: options.onConnectionStateChange,
      onError: (error, context) => this.reportError(error, context),
    });
  }

  get connectionState(): RTCPeerConnectionState {
    return this.controller.connectionState;
  }

  get dataChannelState(): DataChannelState | 'unavailable' {
    return this.dataChannel?.state ?? 'unavailable';
  }

  start(): void {
    this.assertOpen();
    this.controller.start();
  }

  async handleRemoteDescription(
    description: SignalDescription,
  ): Promise<void> {
    this.assertOpen();
    try {
      await this.controller.handleRemoteDescription(description);
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      this.reportError(normalized, 'remote-description');
      throw normalized;
    }
  }

  async handleRemoteIceCandidate(
    candidate: SignalIceCandidate,
  ): Promise<void> {
    this.assertOpen();
    try {
      await this.controller.handleRemoteIceCandidate(candidate);
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      this.reportError(normalized, 'remote-candidate');
      throw normalized;
    }
  }

  async send(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    this.assertOpen();
    if (!this.dataChannel) {
      const error = new Error('Peer DataChannel is not available yet');
      this.reportError(error, 'data-channel-send');
      throw error;
    }

    try {
      await this.dataChannel.send(data);
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      this.reportError(normalized, 'data-channel-send');
      throw normalized;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.dataChannel?.close();
    this.controller.close();
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = new BufferedDataChannel(channel, {
      ...this.options.dataChannel,
      onMessage: this.options.onMessage,
      onStateChange: this.options.onDataChannelStateChange,
      onError: (error) => this.reportError(error, 'data-channel'),
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('WebRtcPeer is closed');
    }
  }

  private reportError(
    error: Error,
    context: WebRtcPeerErrorContext,
  ): void {
    this.options.onError?.(error, context);
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
