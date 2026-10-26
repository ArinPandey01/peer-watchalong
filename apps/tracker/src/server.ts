import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  TrackerControlHandler,
  type ConnectionId,
  type OutboundControlMessage,
} from './control-handler.ts';

export const DEFAULT_TRACKER_PORT = 8080;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_CLOSE_GRACE_MS = 1000;
export const HOST_RESUME_GRACE_MS = 30_000;

export interface TrackerServerOptions {
  port?: number;
  host?: string;
  maxPayloadBytes?: number;
  closeGraceMs?: number;
  hostResumeGraceMs?: number;
  handler?: TrackerControlHandler;
  createConnectionId?: () => ConnectionId;
  logger?: Pick<Console, 'info' | 'error'>;
}

export interface RunningTrackerServer {
  server: WebSocketServer;
  close(): Promise<void>;
}

export async function startTrackerServer(
  options: TrackerServerOptions = {},
): Promise<RunningTrackerServer> {
  const port = options.port ?? DEFAULT_TRACKER_PORT;
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const hostResumeGraceMs = options.hostResumeGraceMs ?? HOST_RESUME_GRACE_MS;
  assertPort(port);
  assertMaxPayload(maxPayload);
  assertCloseGrace(closeGraceMs);
  assertCloseGrace(hostResumeGraceMs);

  const handler = options.handler ?? new TrackerControlHandler();
  const createConnectionId = options.createConnectionId ?? defaultCreateConnectionId;
  const logger = options.logger ?? console;
  const sockets = new Map<ConnectionId, WebSocket>();
  const hostExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const closeUnboundRoomSockets = (connections: ConnectionId[]) => {
    for (const id of connections) {
      if (handler.getBinding(id)) continue;
      sockets.get(id)?.close(1001, 'Host disconnected');
    }
  };

  const server = new WebSocketServer({
    port,
    ...(options.host ? { host: options.host } : {}),
    maxPayload,
  });

  server.on('connection', (socket) => {
    const connectionId = allocateConnectionId(sockets, createConnectionId);
    sockets.set(connectionId, socket);

    socket.on('message', (data, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        socket.close(1003, 'Control messages must be JSON text');
        return;
      }

      try {
        dispatch(sockets, handler.handle(connectionId, rawDataToString(data)));
        const binding = handler.getBinding(connectionId);
        if (binding && !handler.isHostSuspended(binding.sessionId)) {
          const timer = hostExpiryTimers.get(binding.sessionId);
          if (timer) {
            clearTimeout(timer);
            hostExpiryTimers.delete(binding.sessionId);
          }
        }
      } catch (error) {
        logger.error('Unhandled tracker message error', error);
        socket.close(1011, 'Internal tracker error');
      }
    });

    socket.once('close', (_code, reason) => {
      const binding = handler.getBinding(connectionId);
      const roomConnections = binding
        ? [...sockets.keys()].filter(
            (id) => handler.getBinding(id)?.sessionId === binding.sessionId,
          )
        : [];

      sockets.delete(connectionId);
      try {
        const explicitLeave = reason.toString() === 'Leave room';
        dispatch(sockets, handler.disconnect(connectionId, !explicitLeave));

        if (binding && handler.isHostSuspended(binding.sessionId)) {
          const previous = hostExpiryTimers.get(binding.sessionId);
          if (previous) clearTimeout(previous);
          const timer = setTimeout(() => {
            hostExpiryTimers.delete(binding.sessionId);
            const affected = [...sockets.keys()].filter(
              (id) => handler.getBinding(id)?.sessionId === binding.sessionId,
            );
            dispatch(sockets, handler.expireSuspendedHost(binding.sessionId));
            closeUnboundRoomSockets(affected);
          }, hostResumeGraceMs);
          hostExpiryTimers.set(binding.sessionId, timer);
        }

        closeUnboundRoomSockets(roomConnections);
      } catch (error) {
        logger.error('Unhandled tracker disconnect error', error);
      }
    });

    socket.on('error', (error) => {
      logger.error(`WebSocket error for connection ${connectionId}`, error);
    });
  });

  server.on('error', (error) => logger.error('Tracker server error', error));
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onStartupError);
      resolve();
    };
    const onStartupError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onStartupError);
  });

  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    logger.info(`Tracker listening on ws://${address.address}:${address.port}`);
  }
  let closing: Promise<void> | null = null;
  return {
    server,
    close: () => closing ??= (async () => {
      for (const timer of hostExpiryTimers.values()) clearTimeout(timer);
      hostExpiryTimers.clear();
      await closeServer(server, sockets, closeGraceMs);
    })(),
  };
}

function dispatch(
  sockets: ReadonlyMap<ConnectionId, WebSocket>,
  outbound: readonly OutboundControlMessage[],
): void {
  for (const { connectionId, message } of outbound) {
    const socket = sockets.get(connectionId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function allocateConnectionId(
  sockets: ReadonlyMap<ConnectionId, WebSocket>,
  createConnectionId: () => ConnectionId,
): ConnectionId {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createConnectionId();
    if (id && !sockets.has(id)) return id;
  }
  throw new Error('Unable to allocate a unique connection ID');
}

function closeServer(
  server: WebSocketServer,
  sockets: ReadonlyMap<ConnectionId, WebSocket>,
  closeGraceMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      for (const socket of sockets.values()) socket.terminate();
    }, closeGraceMs);
    timer.unref();
    for (const socket of sockets.values()) {
      socket.close(1001, 'Tracker shutting down');
    }
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Tracker port must be an integer from 0 to 65535');
  }
}

function assertMaxPayload(maxPayload: number): void {
  if (!Number.isInteger(maxPayload) || maxPayload <= 0) {
    throw new Error('Maximum payload size must be a positive integer');
  }
}

function assertCloseGrace(closeGraceMs: number): void {
  if (!Number.isSafeInteger(closeGraceMs) || closeGraceMs <= 0) {
    throw new Error('Close grace period must be a positive integer');
  }
}

function defaultCreateConnectionId(): ConnectionId {
  return globalThis.crypto.randomUUID();
}
