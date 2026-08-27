export type SignalDescription = {
  type: 'offer' | 'answer';
  sdp: string;
};

export type SignalIceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

export type PeerConnectionErrorContext =
  | 'negotiation'
  | 'local-candidate'
  | 'data-channel';

export interface PeerConnectionControllerOptions {
  initiator: boolean;
  polite: boolean;
  configuration?: RTCConfiguration;
  channelLabel?: string;
  createPeerConnection?: (
    configuration: RTCConfiguration | undefined,
  ) => RTCPeerConnection;
  onDescription: (description: SignalDescription) => void | Promise<void>;
  onIceCandidate: (
    candidate: SignalIceCandidate,
  ) => void | Promise<void>;
  onDataChannel?: (channel: RTCDataChannel) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onError?: (error: Error, context: PeerConnectionErrorContext) => void;
}

const DEFAULT_CHANNEL_LABEL = 'peer-watchalong';

/**
 * Owns one browser RTCPeerConnection and its signaling lifecycle.
 *
 * Signaling transport is intentionally injected: the tracker remains the
 * authority that validates and relays SIGNAL_SDP and SIGNAL_ICE messages.
 */
export class PeerConnectionController {
  private readonly connection: RTCPeerConnection;
  private readonly options: PeerConnectionControllerOptions;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private channel: RTCDataChannel | undefined;
  private closed = false;

  constructor(options: PeerConnectionControllerOptions) {
    this.options = options;
    const createPeerConnection =
      options.createPeerConnection ??
      ((configuration) => new RTCPeerConnection(configuration));

    this.connection = createPeerConnection(options.configuration);
    this.bindConnectionEvents();
  }

  get connectionState(): RTCPeerConnectionState {
    return this.connection.connectionState;
  }

  get dataChannel(): RTCDataChannel | undefined {
    return this.channel;
  }

  start(): RTCDataChannel | undefined {
    this.assertOpen();

    if (!this.options.initiator) {
      return undefined;
    }

    if (this.channel) {
      return this.channel;
    }

    this.channel = this.connection.createDataChannel(
      this.options.channelLabel ?? DEFAULT_CHANNEL_LABEL,
      { ordered: true },
    );
    this.options.onDataChannel?.(this.channel);
    return this.channel;
  }

  async handleRemoteDescription(
    description: SignalDescription,
  ): Promise<void> {
    this.assertOpen();

    const readyForOffer =
      !this.makingOffer &&
      (this.connection.signalingState === 'stable' ||
        this.isSettingRemoteAnswerPending);
    const offerCollision =
      description.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.options.polite && offerCollision;
    if (this.ignoreOffer) {
      this.pendingCandidates.length = 0;
      return;
    }

    this.isSettingRemoteAnswerPending = description.type === 'answer';
    try {
      await this.connection.setRemoteDescription(description);
    } finally {
      this.isSettingRemoteAnswerPending = false;
    }

    await this.flushPendingCandidates();

    if (description.type === 'offer') {
      await this.connection.setLocalDescription();
      await this.sendLocalDescription();
    }
  }

  async handleRemoteIceCandidate(
    candidate: SignalIceCandidate,
  ): Promise<void> {
    this.assertOpen();

    if (this.ignoreOffer) {
      return;
    }

    if (!this.connection.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }

    await this.connection.addIceCandidate(candidate);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pendingCandidates.length = 0;
    this.connection.onnegotiationneeded = null;
    this.connection.onicecandidate = null;
    this.connection.ondatachannel = null;
    this.connection.onconnectionstatechange = null;
    this.channel?.close();
    this.connection.close();
  }

  private bindConnectionEvents(): void {
    this.connection.onnegotiationneeded = () => {
      void this.negotiate().catch((error: unknown) => {
        this.reportError(error, 'negotiation');
      });
    };

    this.connection.onicecandidate = ({ candidate }) => {
      if (!candidate) {
        return;
      }

      const signalCandidate: SignalIceCandidate = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      };

      Promise.resolve(this.options.onIceCandidate(signalCandidate)).catch(
        (error: unknown) => this.reportError(error, 'local-candidate'),
      );
    };

    this.connection.ondatachannel = ({ channel }) => {
      if (this.channel && this.channel !== channel) {
        channel.close();
        this.reportError(
          new Error('Received a second DataChannel for the same peer'),
          'data-channel',
        );
        return;
      }

      this.channel = channel;
      this.options.onDataChannel?.(channel);
    };

    this.connection.onconnectionstatechange = () => {
      this.options.onConnectionStateChange?.(
        this.connection.connectionState,
      );
    };
  }

  private async negotiate(): Promise<void> {
    this.assertOpen();
    try {
      this.makingOffer = true;
      await this.connection.setLocalDescription();
      await this.sendLocalDescription();
    } finally {
      this.makingOffer = false;
    }
  }

  private async sendLocalDescription(): Promise<void> {
    const description = this.connection.localDescription;
    if (!description) {
      throw new Error('RTCPeerConnection did not produce a local description');
    }

    if (description.type !== 'offer' && description.type !== 'answer') {
      throw new Error(
        `Unsupported local description type: ${description.type}`,
      );
    }

    await this.options.onDescription({
      type: description.type,
      sdp: description.sdp,
    });
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('PeerConnectionController is closed');
    }
  }

  private reportError(
    error: unknown,
    context: PeerConnectionErrorContext,
  ): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized, context);
  }
}
