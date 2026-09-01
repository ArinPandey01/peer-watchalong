export type PeerId = string;
export type SessionId = string;
export type Layer = 0 | 1 | 2 | 3 | 4 | 5;

export type ControlMessageType =
  | 'CREATE_ROOM_REQ'
  | 'CREATE_ROOM_RES'
  | 'JOIN_ROOM_REQ'
  | 'JOIN_ROOM_RES'
  | 'TOPOLOGY_UPDATE_EVENT'
  | 'CHUNK_HAVE_EVENT'
  | 'CHUNK_QUERY_REQ'
  | 'CHUNK_QUERY_RES'
  | 'SIGNAL_SDP'
  | 'SIGNAL_ICE'
  | 'CLOCK_SYNC_REQ'
  | 'CLOCK_SYNC_RES'
  | 'PLAYBACK_SET_REQ'
  | 'PLAYBACK_STATE_EVENT'
  | 'PLAYBACK_STATE_REQ'
  | 'PLAYBACK_STATE_RES'
  | 'ERROR';

export interface BaseControlMessage {
  version: 1;
  type: ControlMessageType;
  messageId: string;
  sessionId: SessionId;
  timestamp: number;
}

export interface PeerControlMessage extends BaseControlMessage {
  senderId: PeerId;
}

export interface ResponseControlMessage extends BaseControlMessage {
  replyTo: string;
}

export interface PeerTopology {
  layer: Layer;
  parents: PeerId[];
  children: PeerId[];
  siblings: PeerId[];
}

export interface PlaybackState {
  playing: boolean;
  mediaTime: number;
  effectiveAt: number;
  playbackRate: number;
  revision: number;
}

export interface PlaybackUpdate {
  playing: boolean;
  mediaTime: number;
  playbackRate: number;
  revision: number;
}

export interface CreateRoomReq extends BaseControlMessage {
  type: 'CREATE_ROOM_REQ';
  payload: Record<string, never>;
}

export interface CreateRoomRes extends ResponseControlMessage {
  type: 'CREATE_ROOM_RES';
  payload: {
    assignedPeerId: PeerId;
    topology: PeerTopology;
  };
}

export interface JoinRoomReq extends BaseControlMessage {
  type: 'JOIN_ROOM_REQ';
  payload: Record<string, never>;
}

export interface JoinRoomRes extends ResponseControlMessage {
  type: 'JOIN_ROOM_RES';
  payload: {
    assignedPeerId: PeerId;
    hostPeerId: PeerId;
    topology: PeerTopology;
  };
}

export interface TopologyUpdateEvent extends BaseControlMessage {
  type: 'TOPOLOGY_UPDATE_EVENT';
  payload: {
    topology: PeerTopology;
  };
}

export interface ChunkHaveEvent extends PeerControlMessage {
  type: 'CHUNK_HAVE_EVENT';
  payload: {
    chunkIndex: number;
  };
}

export interface ChunkQueryReq extends PeerControlMessage {
  type: 'CHUNK_QUERY_REQ';
  payload: {
    chunkIndex: number;
  };
}

export interface ChunkQueryRes extends ResponseControlMessage {
  type: 'CHUNK_QUERY_RES';
  payload: {
    chunkIndex: number;
    holderIds: PeerId[];
  };
}

export interface SignalSdp extends PeerControlMessage {
  type: 'SIGNAL_SDP';
  payload: {
    targetPeerId: PeerId;
    description: {
      type: 'offer' | 'answer';
      sdp: string;
    };
  };
}

export interface SignalIce extends PeerControlMessage {
  type: 'SIGNAL_ICE';
  payload: {
    targetPeerId: PeerId;
    candidate: {
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    };
  };
}

export interface ClockSyncReq extends PeerControlMessage {
  type: 'CLOCK_SYNC_REQ';
  payload: {
    clientSentAt: number;
  };
}

export interface ClockSyncRes extends ResponseControlMessage {
  type: 'CLOCK_SYNC_RES';
  payload: {
    clientSentAt: number;
    trackerReceivedAt: number;
    trackerSentAt: number;
  };
}

export interface PlaybackSetReq extends PeerControlMessage {
  type: 'PLAYBACK_SET_REQ';
  payload: PlaybackUpdate;
}

export interface PlaybackStateEvent extends BaseControlMessage {
  type: 'PLAYBACK_STATE_EVENT';
  payload: {
    state: PlaybackState;
  };
}

export interface PlaybackStateReq extends PeerControlMessage {
  type: 'PLAYBACK_STATE_REQ';
  payload: Record<string, never>;
}

export interface PlaybackStateRes extends ResponseControlMessage {
  type: 'PLAYBACK_STATE_RES';
  payload: {
    state: PlaybackState;
  };
}

export interface ErrorMessage extends BaseControlMessage {
  type: 'ERROR';
  replyTo?: string;
  payload: {
    code:
      | 'INVALID_MESSAGE'
      | 'NOT_REGISTERED'
      | 'NOT_HOST'
      | 'SESSION_ALREADY_EXISTS'
      | 'SESSION_NOT_FOUND'
      | 'PEER_NOT_FOUND'
      | 'NOT_NEIGHBOR'
      | 'INVALID_CHUNK'
      | 'INVALID_PLAYBACK_STATE'
      | 'STALE_PLAYBACK_REVISION'
      | 'SESSION_FULL'
      | 'PROTOCOL_VERSION_UNSUPPORTED';
    message: string;
  };
}

export type ControlMessage =
  | CreateRoomReq
  | CreateRoomRes
  | JoinRoomReq
  | JoinRoomRes
  | TopologyUpdateEvent
  | ChunkHaveEvent
  | ChunkQueryReq
  | ChunkQueryRes
  | SignalSdp
  | SignalIce
  | ClockSyncReq
  | ClockSyncRes
  | PlaybackSetReq
  | PlaybackStateEvent
  | PlaybackStateReq
  | PlaybackStateRes
  | ErrorMessage;
