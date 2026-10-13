import { DATA_PROTOCOL, DataOpcode } from './data.ts';
import type { DataMessage } from './data';

const REQUEST_ID_OFFSET = DATA_PROTOCOL.OPCODE_SIZE;
const CHUNK_INDEX_OFFSET = REQUEST_ID_OFFSET + DATA_PROTOCOL.REQUEST_ID_SIZE;
const UINT32_MAX = 0xffff_ffff;

export function encodeDataMessage(message: DataMessage): Uint8Array {
  assertUint32(message.requestId, 'requestId');
  assertUint32(message.chunkIndex, 'chunkIndex');

  switch (message.opcode) {
    case DataOpcode.REQUEST:
      return encodeHeaderOnlyMessage(
        DataOpcode.REQUEST,
        message.requestId,
        message.chunkIndex,
      );

    case DataOpcode.NOT_AVAILABLE:
      return encodeHeaderOnlyMessage(
        DataOpcode.NOT_AVAILABLE,
        message.requestId,
        message.chunkIndex,
      );

    case DataOpcode.PAYLOAD: {
      if (!(message.data instanceof Uint8Array)) {
        throw new TypeError('PAYLOAD data must be a Uint8Array');
      }

      if (message.data.byteLength === 0) {
        throw new RangeError('PAYLOAD data must not be empty');
      }

      const packet = new Uint8Array(
        DATA_PROTOCOL.PAYLOAD_HEADER_SIZE + message.data.byteLength,
      );
      writeHeader(
        packet,
        DataOpcode.PAYLOAD,
        message.requestId,
        message.chunkIndex,
      );
      packet.set(message.data, DATA_PROTOCOL.PAYLOAD_HEADER_SIZE);
      return packet;
    }

    case DataOpcode.FRAGMENT: {
      if (!(message.data instanceof Uint8Array)) {
        throw new TypeError('FRAGMENT data must be a Uint8Array');
      }
      assertUint32(message.totalBytes, 'totalBytes');
      assertUint32(message.offset, 'offset');
      if (message.totalBytes === 0 || message.data.byteLength === 0 ||
          message.offset + message.data.byteLength > message.totalBytes) {
        throw new RangeError('FRAGMENT range must fit within a nonempty chunk');
      }
      const packet = new Uint8Array(
        DATA_PROTOCOL.FRAGMENT_HEADER_SIZE + message.data.byteLength,
      );
      writeHeader(packet, DataOpcode.FRAGMENT, message.requestId, message.chunkIndex);
      const view = new DataView(packet.buffer);
      view.setUint32(DATA_PROTOCOL.PAYLOAD_HEADER_SIZE, message.totalBytes, false);
      view.setUint32(DATA_PROTOCOL.PAYLOAD_HEADER_SIZE + 4, message.offset, false);
      packet.set(message.data, DATA_PROTOCOL.FRAGMENT_HEADER_SIZE);
      return packet;
    }

    default:
      throw new RangeError('Unknown data opcode');
  }
}

export function decodeDataMessage(
  input: ArrayBuffer | Uint8Array,
): DataMessage {
  const packet = toUint8Array(input);

  if (packet.byteLength < DATA_PROTOCOL.PAYLOAD_HEADER_SIZE) {
    throw new RangeError(
      `Data packet must be at least ${DATA_PROTOCOL.PAYLOAD_HEADER_SIZE} bytes`,
    );
  }

  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  const opcode = view.getUint8(0);
  const requestId = view.getUint32(REQUEST_ID_OFFSET, false);
  const chunkIndex = view.getUint32(CHUNK_INDEX_OFFSET, false);

  switch (opcode) {
    case DataOpcode.REQUEST:
      assertExactSize(packet, DATA_PROTOCOL.REQUEST_SIZE, 'REQUEST');
      return { opcode, requestId, chunkIndex };

    case DataOpcode.NOT_AVAILABLE:
      assertExactSize(
        packet,
        DATA_PROTOCOL.NOT_AVAILABLE_SIZE,
        'NOT_AVAILABLE',
      );
      return { opcode, requestId, chunkIndex };

    case DataOpcode.PAYLOAD:
      if (packet.byteLength === DATA_PROTOCOL.PAYLOAD_HEADER_SIZE) {
        throw new RangeError('PAYLOAD data must not be empty');
      }

      return {
        opcode,
        requestId,
        chunkIndex,
        data: packet.slice(DATA_PROTOCOL.PAYLOAD_HEADER_SIZE),
      };

    case DataOpcode.FRAGMENT: {
      if (packet.byteLength <= DATA_PROTOCOL.FRAGMENT_HEADER_SIZE) {
        throw new RangeError('FRAGMENT data must not be empty');
      }
      const totalBytes = view.getUint32(DATA_PROTOCOL.PAYLOAD_HEADER_SIZE, false);
      const offset = view.getUint32(DATA_PROTOCOL.PAYLOAD_HEADER_SIZE + 4, false);
      const data = packet.slice(DATA_PROTOCOL.FRAGMENT_HEADER_SIZE);
      if (totalBytes === 0 || offset + data.byteLength > totalBytes) {
        throw new RangeError('FRAGMENT range exceeds its chunk');
      }
      return { opcode, requestId, chunkIndex, totalBytes, offset, data };
    }

    default:
      throw new RangeError(`Unknown data opcode: ${opcode}`);
  }
}

function encodeHeaderOnlyMessage(
  opcode: typeof DataOpcode.REQUEST | typeof DataOpcode.NOT_AVAILABLE,
  requestId: number,
  chunkIndex: number,
): Uint8Array {
  const packet = new Uint8Array(DATA_PROTOCOL.REQUEST_SIZE);
  writeHeader(packet, opcode, requestId, chunkIndex);
  return packet;
}

function writeHeader(
  packet: Uint8Array,
  opcode: DataOpcode,
  requestId: number,
  chunkIndex: number,
): void {
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  view.setUint8(0, opcode);
  view.setUint32(REQUEST_ID_OFFSET, requestId, false);
  view.setUint32(CHUNK_INDEX_OFFSET, chunkIndex, false);
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${field} must be an unsigned 32-bit integer`);
  }
}

function assertExactSize(
  packet: Uint8Array,
  expectedSize: number,
  messageName: string,
): void {
  if (packet.byteLength !== expectedSize) {
    throw new RangeError(
      `${messageName} packet must be exactly ${expectedSize} bytes`,
    );
  }
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  throw new TypeError('Data packet must be an ArrayBuffer or Uint8Array');
}
