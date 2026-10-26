import type { ControlMessage } from './control';

const UINT32_MAX = 0xffff_ffff;

const CONTROL_MESSAGE_TYPES = new Set([
  'CREATE_ROOM_REQ',
  'CREATE_ROOM_RES',
  'RESUME_HOST_REQ',
  'RESUME_HOST_RES',
  'HOST_RECONNECTED_EVENT',
  'JOIN_ROOM_REQ',
  'JOIN_ROOM_RES',
  'TOPOLOGY_UPDATE_EVENT',
  'ROOM_CLOSED_EVENT',
  'CHUNK_HAVE_EVENT',
  'CHUNK_QUERY_REQ',
  'CHUNK_QUERY_RES',
  'MEDIA_SET_REQ',
  'MEDIA_SET_RES',
  'MEDIA_EVENT',
  'MEDIA_GET_REQ',
  'MEDIA_GET_RES',
  'SIGNAL_SDP',
  'SIGNAL_ICE',
  'CLOCK_SYNC_REQ',
  'CLOCK_SYNC_RES',
  'PLAYBACK_SET_REQ',
  'PLAYBACK_STATE_EVENT',
  'PLAYBACK_STATE_REQ',
  'PLAYBACK_STATE_RES',
  'ERROR',
] as const);

const ERROR_CODES = new Set([
  'INVALID_MESSAGE',
  'NOT_REGISTERED',
  'NOT_HOST',
  'SESSION_ALREADY_EXISTS',
  'SESSION_NOT_FOUND',
  'PEER_NOT_FOUND',
  'NOT_NEIGHBOR',
  'INVALID_CHUNK',
  'INVALID_PLAYBACK_STATE',
  'STALE_PLAYBACK_REVISION',
  'SESSION_FULL',
  'INVALID_RESUME_TOKEN',
  'PROTOCOL_VERSION_UNSUPPORTED',
] as const);

type JsonObject = Record<string, unknown>;

export class ControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlValidationError';
  }
}

export function parseControlMessage(input: string): ControlMessage {
  let value: unknown;

  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new ControlValidationError('Control message must be valid JSON');
  }

  return validateControlMessage(value);
}

export function validateControlMessage(value: unknown): ControlMessage {
  const message = assertObject(value, 'message');
  assertStringEnum(message.type, CONTROL_MESSAGE_TYPES, 'message.type');

  switch (message.type) {
    case 'CREATE_ROOM_REQ':
    case 'JOIN_ROOM_REQ':
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      validateEmptyPayload(message.payload);
      break;

    case 'CREATE_ROOM_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateCreateRoomPayload(message.payload);
      break;

    case 'RESUME_HOST_REQ': {
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      const payload = assertObject(message.payload, 'message.payload');
      assertExactKeys(payload, ['resumeToken'], 'message.payload');
      assertIdentifier(payload.resumeToken, 'message.payload.resumeToken');
      break;
    }

    case 'RESUME_HOST_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateMembershipPayload(message.payload);
      break;

    case 'HOST_RECONNECTED_EVENT': {
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      const payload = assertObject(message.payload, 'message.payload');
      assertExactKeys(payload, ['hostPeerId'], 'message.payload');
      assertIdentifier(payload.hostPeerId, 'message.payload.hostPeerId');
      break;
    }

    case 'JOIN_ROOM_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateJoinRoomPayload(message.payload);
      break;

    case 'TOPOLOGY_UPDATE_EVENT':
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      validateTopologyPayload(message.payload);
      break;

    case 'ROOM_CLOSED_EVENT': {
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      const payload = assertObject(message.payload, 'message.payload');
      assertExactKeys(payload, ['reason'], 'message.payload');
      assertStringEnum(
        payload.reason,
        new Set(['HOST_DISCONNECTED'] as const),
        'message.payload.reason',
      );
      break;
    }

    case 'CHUNK_HAVE_EVENT':
    case 'CHUNK_QUERY_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateChunkIndexPayload(message.payload);
      break;

    case 'CHUNK_QUERY_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateChunkQueryResponsePayload(message.payload);
      break;

    case 'MEDIA_SET_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateManifestPayload(message.payload, true);
      break;

    case 'MEDIA_SET_RES': {
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      const payload = assertObject(message.payload, 'message.payload');
      assertExactKeys(payload, ['mediaId'], 'message.payload');
      if (payload.mediaId !== null) assertMediaId(payload.mediaId, 'message.payload.mediaId');
      break;
    }

    case 'MEDIA_EVENT':
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      validateManifestPayload(message.payload, true);
      break;

    case 'MEDIA_GET_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateEmptyPayload(message.payload);
      break;

    case 'MEDIA_GET_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateManifestPayload(message.payload, true);
      break;

    case 'SIGNAL_SDP':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateSdpPayload(message.payload);
      break;

    case 'SIGNAL_ICE':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateIcePayload(message.payload);
      break;

    case 'CLOCK_SYNC_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateClockRequestPayload(message.payload);
      break;

    case 'CLOCK_SYNC_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validateClockResponsePayload(message.payload);
      break;

    case 'PLAYBACK_SET_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validatePlaybackUpdate(message.payload, 'message.payload');
      break;

    case 'PLAYBACK_STATE_EVENT':
      validateBaseMessage(message);
      assertExactKeys(message, baseKeys('payload'), 'message');
      validatePlaybackStatePayload(message.payload);
      break;

    case 'PLAYBACK_STATE_REQ':
      validatePeerMessage(message);
      assertExactKeys(message, peerKeys('payload'), 'message');
      validateEmptyPayload(message.payload);
      break;

    case 'PLAYBACK_STATE_RES':
      validateResponseMessage(message);
      assertExactKeys(message, responseKeys('payload'), 'message');
      validatePlaybackStatePayload(message.payload);
      break;

    case 'ERROR':
      validateBaseMessage(message);
      assertExactKeys(
        message,
        baseKeys('payload'),
        'message',
        ['replyTo'],
      );
      if (message.replyTo !== undefined) {
        assertIdentifier(message.replyTo, 'message.replyTo');
      }
      validateErrorPayload(message.payload);
      break;
  }

  return message as unknown as ControlMessage;
}

function validateBaseMessage(message: JsonObject): void {
  if (message.version !== 1) {
    fail('message.version must equal 1');
  }

  assertIdentifier(message.messageId, 'message.messageId');
  assertIdentifier(message.sessionId, 'message.sessionId');
  assertNonNegativeFiniteNumber(message.timestamp, 'message.timestamp');
}

function validatePeerMessage(message: JsonObject): void {
  validateBaseMessage(message);
  assertIdentifier(message.senderId, 'message.senderId');
}

function validateResponseMessage(message: JsonObject): void {
  validateBaseMessage(message);
  assertIdentifier(message.replyTo, 'message.replyTo');
}

function validateEmptyPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, [], 'message.payload');
}

function validateCreateRoomPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['assignedPeerId', 'topology', 'resumeToken'],
    'message.payload',
  );
  assertIdentifier(payload.assignedPeerId, 'message.payload.assignedPeerId');
  validateTopology(payload.topology, 'message.payload.topology');
  assertIdentifier(payload.resumeToken, 'message.payload.resumeToken');
}

function validateMembershipPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['assignedPeerId', 'topology'], 'message.payload');
  assertIdentifier(payload.assignedPeerId, 'message.payload.assignedPeerId');
  validateTopology(payload.topology, 'message.payload.topology');
}

function validateJoinRoomPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['assignedPeerId', 'hostPeerId', 'topology'],
    'message.payload',
  );
  assertIdentifier(payload.assignedPeerId, 'message.payload.assignedPeerId');
  assertIdentifier(payload.hostPeerId, 'message.payload.hostPeerId');
  validateTopology(payload.topology, 'message.payload.topology');
}

function validateTopologyPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['topology'], 'message.payload');
  validateTopology(payload.topology, 'message.payload.topology');
}

function validateTopology(value: unknown, path: string): void {
  const topology = assertObject(value, path);
  assertExactKeys(
    topology,
    ['layer', 'parents', 'children', 'siblings'],
    path,
  );

  assertLayer(topology.layer, `${path}.layer`);
  assertIdentifierArray(topology.parents, `${path}.parents`);
  assertIdentifierArray(topology.children, `${path}.children`);
  assertIdentifierArray(topology.siblings, `${path}.siblings`);
}

function validateChunkIndexPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['mediaId', 'chunkIndex'], 'message.payload');
  assertMediaId(payload.mediaId, 'message.payload.mediaId');
  assertUint32(payload.chunkIndex, 'message.payload.chunkIndex');
}

function validateChunkQueryResponsePayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['mediaId', 'chunkIndex', 'holderIds'],
    'message.payload',
  );
  assertMediaId(payload.mediaId, 'message.payload.mediaId');
  assertUint32(payload.chunkIndex, 'message.payload.chunkIndex');
  assertIdentifierArray(payload.holderIds, 'message.payload.holderIds');
}

function validateManifestPayload(value: unknown, nullable: boolean): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['manifest'], 'message.payload');
  if (nullable && payload.manifest === null) return;
  validateManifest(payload.manifest);
}

function validateManifest(value: unknown): void {
  const manifest = assertObject(value, 'message.payload.manifest');
  const root = 'message.payload.manifest';
  assertExactKeys(manifest, ['mediaId', 'durationSec', 'tracks', 'chunks'], root, ['totalChunks']);
  assertMediaId(manifest.mediaId, `${root}.mediaId`);
  assertPositiveFiniteNumber(manifest.durationSec, `${root}.durationSec`);
  if (manifest.totalChunks !== undefined) {
    assertUint32(manifest.totalChunks, `${root}.totalChunks`);
  }
  if (!Array.isArray(manifest.tracks) || manifest.tracks.length < 1 ||
      manifest.tracks.length > 2) fail(`${root}.tracks must contain one or two tracks`);
  const trackKinds = new Set<string>();
  const trackIds = new Set<number>();
  for (const [index, value] of manifest.tracks.entries()) {
    const path = `${root}.tracks[${index}]`;
    const track = assertObject(value, path);
    assertExactKeys(track, ['id', 'kind', 'mimeType'], path);
    assertUint32(track.id, `${path}.id`);
    assertStringEnum(track.kind, new Set(['audio', 'video'] as const), `${path}.kind`);
    assertString(track.mimeType, `${path}.mimeType`);
    if (track.id === 0 || trackIds.has(track.id) || trackKinds.has(track.kind)) {
      fail(`${path} has a duplicate or invalid track`);
    }
    if (!new RegExp(`^${track.kind}/mp4; codecs="[A-Za-z0-9.,_-]{1,80}"$`).test(track.mimeType)) {
      fail(`${path}.mimeType must describe an MP4 codec`);
    }
    trackIds.add(track.id);
    trackKinds.add(track.kind);
  }
  if (!trackKinds.has('video')) fail(`${root}.tracks must include video`);
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < trackIds.size + 1 ||
      manifest.chunks.length > 512) fail(`${root}.chunks has an unsupported length`);
  const initialized = new Set<number>();
  const mediaTracks = new Set<number>();
  const lastEnd = new Map<number, number>();
  let previousIndex = -1;
  for (const [index, value] of manifest.chunks.entries()) {
    const path = `${root}.chunks[${index}]`;
    const chunk = assertObject(value, path);
    const bundled = 'parts' in chunk;
    assertExactKeys(chunk, bundled
      ? ['chunkIndex', 'kind', 'startTimeSec', 'endTimeSec', 'byteLength', 'sha256', 'parts']
      : ['chunkIndex', 'trackId', 'kind', 'startTimeSec', 'endTimeSec', 'byteLength', 'sha256'], path);
    assertUint32(chunk.chunkIndex, `${path}.chunkIndex`);
    if (!bundled) assertUint32(chunk.trackId, `${path}.trackId`);
    assertStringEnum(chunk.kind, new Set(['init', 'media'] as const), `${path}.kind`);
    assertNonNegativeFiniteNumber(chunk.startTimeSec, `${path}.startTimeSec`);
    assertNonNegativeFiniteNumber(chunk.endTimeSec, `${path}.endTimeSec`);
    assertUint32(chunk.byteLength, `${path}.byteLength`);
    assertString(chunk.sha256, `${path}.sha256`);
    if (!/^[0-9a-f]{64}$/.test(chunk.sha256)) {
      fail(`${path}.sha256 must be a SHA-256 hex digest`);
    }
    if ((manifest.totalChunks === undefined
          ? chunk.chunkIndex !== index
          : chunk.chunkIndex <= previousIndex) ||
        (manifest.totalChunks !== undefined &&
          chunk.chunkIndex >= (manifest.totalChunks as number)) ||
        (!bundled && !trackIds.has(chunk.trackId as number)) ||
        chunk.byteLength < 1 || chunk.byteLength > 16 * 1024 * 1024) {
      fail(`${path} has an invalid index, track, or size`);
    }
    previousIndex = chunk.chunkIndex as number;
    if (bundled) {
      if (chunk.kind !== 'media' || initialized.size !== trackIds.size ||
          chunk.endTimeSec <= chunk.startTimeSec ||
          chunk.endTimeSec > (manifest.durationSec as number) + 1 ||
          !Array.isArray(chunk.parts) || chunk.parts.length < 1 ||
          chunk.parts.length > trackIds.size) {
        fail(`${path} has invalid bundled media`);
      }
      const partTracks = new Set<number>();
      let bundleLength = 8 + chunk.parts.length * 8;
      let hasVideo = false;
      for (const [partIndex, value] of chunk.parts.entries()) {
        const partPath = `${path}.parts[${partIndex}]`;
        const part = assertObject(value, partPath);
        assertExactKeys(part, ['trackId', 'startTimeSec', 'endTimeSec', 'byteLength'], partPath);
        assertUint32(part.trackId, `${partPath}.trackId`);
        assertNonNegativeFiniteNumber(part.startTimeSec, `${partPath}.startTimeSec`);
        assertNonNegativeFiniteNumber(part.endTimeSec, `${partPath}.endTimeSec`);
        assertUint32(part.byteLength, `${partPath}.byteLength`);
        if (!trackIds.has(part.trackId) || partTracks.has(part.trackId) ||
            part.byteLength < 1 || part.endTimeSec <= part.startTimeSec ||
            part.endTimeSec > (manifest.durationSec as number) + 1 ||
            part.startTimeSec < (lastEnd.get(part.trackId) ?? 0) - 0.25) {
          fail(`${partPath} has invalid media data`);
        }
        partTracks.add(part.trackId as number);
        bundleLength += part.byteLength as number;
        lastEnd.set(part.trackId as number, part.endTimeSec as number);
        mediaTracks.add(part.trackId as number);
        if (manifest.tracks.some((track) => track.id === part.trackId && track.kind === 'video')) {
          hasVideo = true;
          if (Math.abs((part.startTimeSec as number) - (chunk.startTimeSec as number)) > 0.25 ||
              Math.abs((part.endTimeSec as number) - (chunk.endTimeSec as number)) > 0.25) {
            fail(`${partPath} does not match the bundle time`);
          }
        }
      }
      if (!hasVideo || bundleLength !== chunk.byteLength) {
        fail(`${path} has invalid bundle contents`);
      }
    } else if (chunk.kind === 'init') {
      if (initialized.has(chunk.trackId as number) || mediaTracks.size > 0 ||
          chunk.startTimeSec !== 0 || chunk.endTimeSec !== 0) {
        fail(`${path} has an invalid initialization segment`);
      }
      initialized.add(chunk.trackId as number);
    } else {
      if (!initialized.has(chunk.trackId as number) ||
          chunk.endTimeSec <= chunk.startTimeSec ||
          chunk.endTimeSec > (manifest.durationSec as number) + 1 ||
          chunk.startTimeSec < (lastEnd.get(chunk.trackId as number) ?? 0) - 0.25) {
        fail(`${path} has an invalid media time range`);
      }
      lastEnd.set(chunk.trackId as number, chunk.endTimeSec as number);
      mediaTracks.add(chunk.trackId as number);
    }
  }
  if (initialized.size !== trackIds.size || mediaTracks.size !== trackIds.size) {
    fail(`${root}.chunks must initialize every track and contain media for each track`);
  }
  if (JSON.stringify(manifest).length > 48 * 1024) {
    fail(`${root} exceeds the size limit`);
  }
}

function assertMediaId(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (value.length > 64) fail(`${path} is too long`);
}

function validateSdpPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['targetPeerId', 'description'],
    'message.payload',
  );
  assertIdentifier(payload.targetPeerId, 'message.payload.targetPeerId');

  const description = assertObject(
    payload.description,
    'message.payload.description',
  );
  assertExactKeys(description, ['type', 'sdp'], 'message.payload.description');
  assertStringEnum(
    description.type,
    new Set(['offer', 'answer'] as const),
    'message.payload.description.type',
  );
  assertNonEmptyString(description.sdp, 'message.payload.description.sdp');
}

function validateIcePayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['targetPeerId', 'candidate'],
    'message.payload',
  );
  assertIdentifier(payload.targetPeerId, 'message.payload.targetPeerId');

  const candidate = assertObject(payload.candidate, 'message.payload.candidate');
  assertExactKeys(
    candidate,
    ['candidate', 'sdpMid', 'sdpMLineIndex'],
    'message.payload.candidate',
  );
  assertString(candidate.candidate, 'message.payload.candidate.candidate');
  assertNullableString(candidate.sdpMid, 'message.payload.candidate.sdpMid');
  assertNullableNonNegativeInteger(
    candidate.sdpMLineIndex,
    'message.payload.candidate.sdpMLineIndex',
  );
}

function validateClockRequestPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['clientSentAt'], 'message.payload');
  assertNonNegativeFiniteNumber(
    payload.clientSentAt,
    'message.payload.clientSentAt',
  );
}

function validateClockResponsePayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['clientSentAt', 'trackerReceivedAt', 'trackerSentAt'],
    'message.payload',
  );
  assertNonNegativeFiniteNumber(
    payload.clientSentAt,
    'message.payload.clientSentAt',
  );
  assertNonNegativeFiniteNumber(
    payload.trackerReceivedAt,
    'message.payload.trackerReceivedAt',
  );
  assertNonNegativeFiniteNumber(
    payload.trackerSentAt,
    'message.payload.trackerSentAt',
  );
}

function validatePlaybackUpdate(value: unknown, path: string): void {
  const update = assertObject(value, path);
  assertExactKeys(
    update,
    ['playing', 'mediaTime', 'playbackRate', 'revision'],
    path,
  );
  assertBoolean(update.playing, `${path}.playing`);
  assertNonNegativeFiniteNumber(update.mediaTime, `${path}.mediaTime`);
  assertPositiveFiniteNumber(update.playbackRate, `${path}.playbackRate`);
  assertUint32(update.revision, `${path}.revision`);
}

function validatePlaybackStatePayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['state'], 'message.payload');

  const state = assertObject(payload.state, 'message.payload.state');
  assertExactKeys(
    state,
    ['playing', 'mediaTime', 'effectiveAt', 'playbackRate', 'revision'],
    'message.payload.state',
  );
  assertBoolean(state.playing, 'message.payload.state.playing');
  assertNonNegativeFiniteNumber(
    state.mediaTime,
    'message.payload.state.mediaTime',
  );
  assertNonNegativeFiniteNumber(
    state.effectiveAt,
    'message.payload.state.effectiveAt',
  );
  assertPositiveFiniteNumber(
    state.playbackRate,
    'message.payload.state.playbackRate',
  );
  assertUint32(state.revision, 'message.payload.state.revision');
}

function validateErrorPayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(payload, ['code', 'message'], 'message.payload');
  assertStringEnum(payload.code, ERROR_CODES, 'message.payload.code');
  assertNonEmptyString(payload.message, 'message.payload.message');
}

function baseKeys(...extra: string[]): string[] {
  return ['version', 'type', 'messageId', 'sessionId', 'timestamp', ...extra];
}

function peerKeys(...extra: string[]): string[] {
  return [...baseKeys(), 'senderId', ...extra];
}

function responseKeys(...extra: string[]): string[] {
  return [...baseKeys(), 'replyTo', ...extra];
}

function assertObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }

  return value as JsonObject;
}

function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const requiredKeys = new Set(required);
  const allowedKeys = new Set([...required, ...optional]);

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key} is required`);
    }
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${path}.${key} is not allowed`);
    }
  }
}

function assertIdentifier(
  value: unknown,
  path: string,
): asserts value is string {
  assertNonEmptyString(value, path);
}

function assertIdentifierArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }

  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertIdentifier(item, `${path}[${index}]`);

    if (seen.has(item)) {
      fail(`${path} must not contain duplicate peer IDs`);
    }
    seen.add(item);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') {
    fail(`${path} must be a string`);
  }
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`);
  }
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null) {
    assertString(value, path);
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') {
    fail(`${path} must be a boolean`);
  }
}

function assertUint32(value: unknown, path: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) {
    fail(`${path} must be an unsigned 32-bit integer`);
  }
}

function assertLayer(value: unknown, path: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 5
  ) {
    fail(`${path} must be an integer from 0 through 5`);
  }
}

function assertNonNegativeFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${path} must be a non-negative finite number`);
  }
}

function assertPositiveFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${path} must be a positive finite number`);
  }
}

function assertNullableNonNegativeInteger(value: unknown, path: string): void {
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
  ) {
    fail(`${path} must be a non-negative integer or null`);
  }
}

function assertStringEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    fail(`${path} has an unsupported value`);
  }
}

function fail(message: string): never {
  throw new ControlValidationError(message);
}
