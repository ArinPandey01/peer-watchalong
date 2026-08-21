import type { ControlMessage } from './control';

const UINT32_MAX = 0xffff_ffff;

const CONTROL_MESSAGE_TYPES = new Set([
  'CREATE_ROOM_REQ',
  'CREATE_ROOM_RES',
  'JOIN_ROOM_REQ',
  'JOIN_ROOM_RES',
  'TOPOLOGY_UPDATE_EVENT',
  'CHUNK_HAVE_EVENT',
  'CHUNK_QUERY_REQ',
  'CHUNK_QUERY_RES',
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
    ['assignedPeerId', 'topology'],
    'message.payload',
  );
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
  assertExactKeys(payload, ['chunkIndex'], 'message.payload');
  assertUint32(payload.chunkIndex, 'message.payload.chunkIndex');
}

function validateChunkQueryResponsePayload(value: unknown): void {
  const payload = assertObject(value, 'message.payload');
  assertExactKeys(
    payload,
    ['chunkIndex', 'holderIds'],
    'message.payload',
  );
  assertUint32(payload.chunkIndex, 'message.payload.chunkIndex');
  assertIdentifierArray(payload.holderIds, 'message.payload.holderIds');
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

function assertUint32(value: unknown, path: string): void {
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

function assertNonNegativeFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${path} must be a non-negative finite number`);
  }
}

function assertPositiveFiniteNumber(value: unknown, path: string): void {
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
