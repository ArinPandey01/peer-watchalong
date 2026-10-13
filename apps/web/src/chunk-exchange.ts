import {
  DATA_PROTOCOL,
  DataOpcode,
  decodeDataMessage,
  encodeDataMessage,
  type ChunkFragment,
  type ChunkNotAvailable,
  type ChunkPayload,
} from '@peer-watchalong/protocol';

type ChunkResult = ChunkPayload | ChunkNotAvailable;

interface PartialChunk {
  totalBytes: number;
  nextOffset: number;
  data: Uint8Array;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ChunkExchangeOptions {
  readChunk: (chunkIndex: number) => Uint8Array | null | Promise<Uint8Array | null>;
  send: (peerId: string, packet: Uint8Array) => Promise<void>;
  onResult: (peerId: string, result: ChunkResult) => void;
  onError?: (error: Error) => void;
  maxPacketBytes?: number;
  maxChunkBytes?: number;
  maxPartialChunks?: number;
  partialTimeoutMs?: number;
  maxConcurrentServes?: number;
}

export class ChunkExchange {
  private readonly options: Required<ChunkExchangeOptions>;
  private readonly partials = new Map<string, PartialChunk>();
  private activeServes = 0;
  private closed = false;

  constructor(options: ChunkExchangeOptions) {
    this.options = {
      ...options,
      onError: options.onError ?? (() => {}),
      maxPacketBytes: options.maxPacketBytes ?? 16 * 1024,
      maxChunkBytes: options.maxChunkBytes ?? 16 * 1024 * 1024,
      maxPartialChunks: options.maxPartialChunks ?? 6,
      partialTimeoutMs: options.partialTimeoutMs ?? 5_000,
      maxConcurrentServes: options.maxConcurrentServes ?? 4,
    };
    if (!Number.isSafeInteger(this.options.maxPacketBytes) ||
        this.options.maxPacketBytes <= DATA_PROTOCOL.FRAGMENT_HEADER_SIZE ||
        !Number.isSafeInteger(this.options.maxChunkBytes) ||
        this.options.maxChunkBytes <= 0 ||
        !Number.isSafeInteger(this.options.maxPartialChunks) ||
        this.options.maxPartialChunks <= 0 ||
        !Number.isSafeInteger(this.options.partialTimeoutMs) ||
        this.options.partialTimeoutMs <= 0 ||
        !Number.isSafeInteger(this.options.maxConcurrentServes) ||
        this.options.maxConcurrentServes <= 0) {
      throw new RangeError('Chunk exchange limits must be positive integers');
    }
  }

  request(peerId: string, chunkIndex: number, requestId: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Chunk exchange is closed'));
    const packet = encodeDataMessage({ opcode: DataOpcode.REQUEST, requestId, chunkIndex });
    return this.options.send(peerId, packet);
  }

  async receive(peerId: string, packet: Uint8Array): Promise<void> {
    if (this.closed) return;
    try {
      if (packet.byteLength > this.options.maxPacketBytes) {
        throw new RangeError('DataChannel packet exceeds the configured maximum');
      }
      const message = decodeDataMessage(packet);
      switch (message.opcode) {
        case DataOpcode.REQUEST:
          await this.serve(peerId, message.chunkIndex, message.requestId);
          break;
        case DataOpcode.PAYLOAD:
          if (message.data.byteLength > this.options.maxChunkBytes) {
            throw new RangeError('Chunk payload exceeds the configured maximum');
          }
          this.clearPartial(peerId, message.requestId, message.chunkIndex);
          this.options.onResult(peerId, message);
          break;
        case DataOpcode.NOT_AVAILABLE:
          this.clearPartial(peerId, message.requestId, message.chunkIndex);
          this.options.onResult(peerId, message);
          break;
        case DataOpcode.FRAGMENT:
          this.acceptFragment(peerId, message);
          break;
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const partial of this.partials.values()) clearTimeout(partial.timeout);
    this.partials.clear();
  }

  private async serve(peerId: string, chunkIndex: number, requestId: number): Promise<void> {
    if (this.activeServes >= this.options.maxConcurrentServes) {
      await this.sendUnavailable(peerId, chunkIndex, requestId);
      return;
    }
    this.activeServes += 1;
    try {
      const data = await this.options.readChunk(chunkIndex);
      if (this.closed) return;
      if (!data || data.byteLength === 0 ||
          data.byteLength > this.options.maxChunkBytes) {
        await this.sendUnavailable(peerId, chunkIndex, requestId);
        return;
      }
      const smallLimit = this.options.maxPacketBytes - DATA_PROTOCOL.PAYLOAD_HEADER_SIZE;
      if (data.byteLength <= smallLimit) {
        await this.options.send(peerId, encodeDataMessage({
          opcode: DataOpcode.PAYLOAD, requestId, chunkIndex, data,
        }));
        return;
      }
      const fragmentLimit = this.options.maxPacketBytes - DATA_PROTOCOL.FRAGMENT_HEADER_SIZE;
      for (let offset = 0; offset < data.byteLength && !this.closed; offset += fragmentLimit) {
        await this.options.send(peerId, encodeDataMessage({
          opcode: DataOpcode.FRAGMENT,
          requestId,
          chunkIndex,
          totalBytes: data.byteLength,
          offset,
          data: data.subarray(offset, offset + fragmentLimit),
        }));
      }
    } catch (error) {
      this.reportError(error);
      if (!this.closed) {
        try {
          await this.sendUnavailable(peerId, chunkIndex, requestId);
        } catch (sendError) {
          this.reportError(sendError);
        }
      }
    } finally {
      this.activeServes -= 1;
    }
  }

  private sendUnavailable(peerId: string, chunkIndex: number, requestId: number): Promise<void> {
    return this.options.send(peerId, encodeDataMessage({
      opcode: DataOpcode.NOT_AVAILABLE, requestId, chunkIndex,
    }));
  }

  private acceptFragment(peerId: string, fragment: ChunkFragment): void {
    const key = `${peerId}:${fragment.requestId}:${fragment.chunkIndex}`;
    let partial = this.partials.get(key);
    if (!partial) {
      if (fragment.offset !== 0 ||
          fragment.totalBytes > this.options.maxChunkBytes ||
          this.partials.size >= this.options.maxPartialChunks) {
        throw new RangeError('Cannot start a chunk fragment assembly');
      }
      const timeout = setTimeout(() => {
        this.partials.delete(key);
        this.reportError(new Error('Chunk fragment assembly timed out'));
      }, this.options.partialTimeoutMs);
      partial = {
        totalBytes: fragment.totalBytes,
        nextOffset: 0,
        data: new Uint8Array(fragment.totalBytes),
        timeout,
      };
      this.partials.set(key, partial);
    }
    if (partial.totalBytes !== fragment.totalBytes ||
        partial.nextOffset !== fragment.offset) {
      clearTimeout(partial.timeout);
      this.partials.delete(key);
      throw new RangeError('Chunk fragments are inconsistent or out of order');
    }
    partial.data.set(fragment.data, fragment.offset);
    partial.nextOffset += fragment.data.byteLength;
    if (partial.nextOffset === partial.totalBytes) {
      clearTimeout(partial.timeout);
      this.partials.delete(key);
      this.options.onResult(peerId, {
        opcode: DataOpcode.PAYLOAD,
        requestId: fragment.requestId,
        chunkIndex: fragment.chunkIndex,
        data: partial.data,
      });
    }
  }

  private clearPartial(peerId: string, requestId: number, chunkIndex: number): void {
    const key = `${peerId}:${requestId}:${chunkIndex}`;
    const partial = this.partials.get(key);
    if (!partial) return;
    clearTimeout(partial.timeout);
    this.partials.delete(key);
  }

  private reportError(error: unknown): void {
    this.options.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
