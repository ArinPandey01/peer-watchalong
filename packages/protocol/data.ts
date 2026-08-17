export enum DataOpcode {
  REQUEST = 0x01,
  PAYLOAD = 0x02,
  NOT_AVAILABLE = 0x03,
}

export interface ChunkRequest {
  opcode: DataOpcode.REQUEST;
  requestId: number;
  chunkIndex: number;
}

export interface ChunkPayload {
  opcode: DataOpcode.PAYLOAD;
  requestId: number;
  chunkIndex: number;
  data: Uint8Array;
}

export interface ChunkNotAvailable {
  opcode: DataOpcode.NOT_AVAILABLE;
  requestId: number;
  chunkIndex: number;
}

export type DataMessage =
  | ChunkRequest
  | ChunkPayload
  | ChunkNotAvailable;

export const DATA_PROTOCOL = {
  VERSION: 1,

  OPCODE_SIZE: 1,
  REQUEST_ID_SIZE: 4,
  CHUNK_INDEX_SIZE: 4,

  REQUEST_SIZE: 9,
  NOT_AVAILABLE_SIZE: 9,
  PAYLOAD_HEADER_SIZE: 9,
} as const;
