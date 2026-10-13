export const DataOpcode = {
  REQUEST: 0x01,
  PAYLOAD: 0x02,
  NOT_AVAILABLE: 0x03,
  FRAGMENT: 0x04,
} as const;
export type DataOpcode = typeof DataOpcode[keyof typeof DataOpcode];

export interface ChunkRequest {
  opcode: typeof DataOpcode.REQUEST;
  requestId: number;
  chunkIndex: number;
}

export interface ChunkPayload {
  opcode: typeof DataOpcode.PAYLOAD;
  requestId: number;
  chunkIndex: number;
  data: Uint8Array;
}

export interface ChunkNotAvailable {
  opcode: typeof DataOpcode.NOT_AVAILABLE;
  requestId: number;
  chunkIndex: number;
}

export interface ChunkFragment {
  opcode: typeof DataOpcode.FRAGMENT;
  requestId: number;
  chunkIndex: number;
  totalBytes: number;
  offset: number;
  data: Uint8Array;
}

export type DataMessage =
  | ChunkRequest
  | ChunkPayload
  | ChunkNotAvailable
  | ChunkFragment;

export const DATA_PROTOCOL = {
  VERSION: 1,

  OPCODE_SIZE: 1,
  REQUEST_ID_SIZE: 4,
  CHUNK_INDEX_SIZE: 4,

  REQUEST_SIZE: 9,
  NOT_AVAILABLE_SIZE: 9,
  PAYLOAD_HEADER_SIZE: 9,
  FRAGMENT_HEADER_SIZE: 17,
} as const;
