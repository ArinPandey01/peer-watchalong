export type DataChannelState = RTCDataChannelState;

export interface BufferedDataChannelOptions {
  highWaterMark?: number;
  lowWaterMark?: number;
  maxMessageSize?: number;
  onMessage?: (data: Uint8Array) => void;
  onStateChange?: (state: DataChannelState) => void;
  onError?: (error: Error) => void;
}

interface PendingSend {
  data: Uint8Array<ArrayBuffer>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_LOW_WATER_MARK = 256 * 1024;

/**
 * Adds bounded application-level queuing to a reliable RTCDataChannel.
 *
 * A send resolves when the browser accepts the message into its DataChannel
 * buffer. Delivery acknowledgement remains the responsibility of the
 * application protocol.
 */
export class BufferedDataChannel {
  private readonly channel: RTCDataChannel;
  private readonly options: BufferedDataChannelOptions;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly pending: PendingSend[] = [];
  private closed = false;

  constructor(
    channel: RTCDataChannel,
    options: BufferedDataChannelOptions = {},
  ) {
    this.channel = channel;
    this.options = options;
    this.highWaterMark =
      options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.lowWaterMark = options.lowWaterMark ?? DEFAULT_LOW_WATER_MARK;
    this.validateOptions();

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.lowWaterMark;
    this.bindChannelEvents();
  }

  get label(): string {
    return this.channel.label;
  }

  get state(): DataChannelState {
    return this.channel.readyState;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  get pendingMessageCount(): number {
    return this.pending.length;
  }

  send(input: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (
      this.closed ||
      this.channel.readyState === 'closing' ||
      this.channel.readyState === 'closed'
    ) {
      return Promise.reject(
        new Error(`Cannot send on a ${this.channel.readyState} DataChannel`),
      );
    }

    const data = toUint8Array(input);
    if (
      this.options.maxMessageSize !== undefined &&
      data.byteLength > this.options.maxMessageSize
    ) {
      return Promise.reject(
        new RangeError(
          `DataChannel message is ${data.byteLength} bytes; maximum is ` +
            `${this.options.maxMessageSize} bytes`,
        ),
      );
    }

    if (this.pending.length === 0 && this.canSend(data.byteLength)) {
      try {
        this.channel.send(data);
        return Promise.resolve();
      } catch (error: unknown) {
        const normalized = normalizeError(error);
        this.options.onError?.(normalized);
        return Promise.reject(normalized);
      }
    }

    // Copy queued views so callers can safely reuse or mutate their buffer.
    const queuedData = data.slice();
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ data: queuedData, resolve, reject });
      this.flush();
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectPending(new Error('DataChannel closed before send'));
    if (
      this.channel.readyState !== 'closing' &&
      this.channel.readyState !== 'closed'
    ) {
      this.channel.close();
    }
  }

  private bindChannelEvents(): void {
    this.channel.onopen = () => {
      this.options.onStateChange?.(this.channel.readyState);
      this.flush();
    };

    this.channel.onbufferedamountlow = () => {
      this.flush();
    };

    this.channel.onmessage = ({ data }) => {
      try {
        this.options.onMessage?.(toUint8Array(data));
      } catch (error: unknown) {
        this.options.onError?.(normalizeError(error));
      }
    };

    this.channel.onerror = (event) => {
      const rtcError = 'error' in event ? event.error : undefined;
      this.options.onError?.(
        rtcError instanceof Error
          ? rtcError
          : new Error('RTCDataChannel reported an error'),
      );
    };

    this.channel.onclosing = () => {
      this.options.onStateChange?.(this.channel.readyState);
    };

    this.channel.onclose = () => {
      this.closed = true;
      this.rejectPending(new Error('DataChannel closed before send'));
      this.options.onStateChange?.(this.channel.readyState);
    };
  }

  private canSend(messageSize: number): boolean {
    if (this.channel.readyState !== 'open') {
      return false;
    }

    return (
      this.channel.bufferedAmount === 0 ||
      this.channel.bufferedAmount + messageSize <= this.highWaterMark
    );
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!this.canSend(next.data.byteLength)) {
        return;
      }

      this.pending.shift();
      try {
        this.channel.send(next.data);
        next.resolve();
      } catch (error: unknown) {
        const normalized = normalizeError(error);
        next.reject(normalized);
        this.options.onError?.(normalized);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const send of this.pending.splice(0)) {
      send.reject(error);
    }
  }

  private validateOptions(): void {
    if (!Number.isSafeInteger(this.highWaterMark) || this.highWaterMark <= 0) {
      throw new RangeError('highWaterMark must be a positive integer');
    }

    if (!Number.isSafeInteger(this.lowWaterMark) || this.lowWaterMark < 0) {
      throw new RangeError('lowWaterMark must be a non-negative integer');
    }

    if (this.lowWaterMark >= this.highWaterMark) {
      throw new RangeError('lowWaterMark must be less than highWaterMark');
    }

    if (
      this.options.maxMessageSize !== undefined &&
      (!Number.isSafeInteger(this.options.maxMessageSize) ||
        this.options.maxMessageSize <= 0)
    ) {
      throw new RangeError('maxMessageSize must be a positive integer');
    }
  }
}

function toUint8Array(input: unknown): Uint8Array<ArrayBuffer> {
  if (input instanceof Uint8Array) {
    return Uint8Array.from(input);
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (ArrayBuffer.isView(input)) {
    return Uint8Array.from(
      new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    );
  }

  throw new TypeError('DataChannel messages must contain binary data');
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
