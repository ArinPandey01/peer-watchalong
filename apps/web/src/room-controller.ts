import {
  TrackerRequestError,
  type TrackerClient,
} from '@peer-watchalong/tracker-client';
import { generateRoomCode, normalizeRoomCode } from './room-code.ts';

type Role = 'host' | 'viewer';
type TrackerConnection = Pick<
  TrackerClient,
  'connect' | 'createRoom' | 'joinRoom' | 'disconnect' | 'on'
>;

export type RoomView =
  | { screen: 'home'; error?: string; enteredCode?: string }
  | { screen: 'connecting'; role: Role; code: string }
  | {
      screen: 'room';
      role: Role;
      code: string;
      connection: 'connected' | 'disconnected';
    }
  | { screen: 'ended'; code: string; reason: string };

export class RoomController {
  private state: RoomView = { screen: 'home' };
  private readonly listeners = new Set<(state: RoomView) => void>();
  private readonly createClient: () => TrackerConnection;
  private readonly createCode: () => string;
  private client: TrackerConnection | null = null;
  private subscriptions: Array<() => void> = [];

  constructor(
    createClient: () => TrackerConnection,
    createCode: () => string = generateRoomCode,
  ) {
    this.createClient = createClient;
    this.createCode = createCode;
  }

  get current(): RoomView {
    return this.state;
  }

  subscribe(listener: (state: RoomView) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async createRoom(): Promise<void> {
    if (this.state.screen === 'connecting') return;
    await this.start('host', this.createCode());
  }

  async joinRoom(enteredCode: string): Promise<void> {
    if (this.state.screen === 'connecting') return;
    const code = normalizeRoomCode(enteredCode);
    if (!code) {
      this.setState({
        screen: 'home',
        error: 'Enter an eight-character room code.',
        enteredCode,
      });
      return;
    }
    await this.start('viewer', code);
  }

  async retry(): Promise<void> {
    if (
      this.state.screen !== 'room' ||
      this.state.role !== 'viewer' ||
      this.state.connection !== 'disconnected'
    ) return;
    await this.start('viewer', this.state.code);
  }

  leave(): void {
    this.releaseClient();
    this.setState({ screen: 'home' });
  }

  private async start(role: Role, initialCode: string): Promise<void> {
    this.releaseClient();
    const client = this.createClient();
    this.client = client;
    let code = initialCode;
    this.subscriptions = [
      client.on('roomClosed', () => {
        if (this.client !== client) return;
        this.releaseClient();
        this.setState({
          screen: 'ended',
          code,
          reason: 'The host left. This room has ended.',
        });
      }),
      client.on('close', () => {
        if (this.client !== client) return;
        if (this.state.screen !== 'room') return;
        this.releaseClient();
        if (role === 'host') {
          this.setState({
            screen: 'ended',
            code,
            reason: 'Your connection closed, so the room has ended.',
          });
        } else {
          this.setState({
            screen: 'room',
            role,
            code,
            connection: 'disconnected',
          });
        }
      }),
    ];
    this.setState({ screen: 'connecting', role, code });

    try {
      await client.connect();
      if (this.client !== client) return;
      if (role === 'host') {
        let registered = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await client.createRoom(code);
            registered = true;
            break;
          } catch (error) {
            if (
              !(error instanceof TrackerRequestError) ||
              error.code !== 'SESSION_ALREADY_EXISTS' ||
              attempt === 2
            ) throw error;
            code = this.createCode();
            this.setState({ screen: 'connecting', role, code });
          }
        }
        if (!registered) return;
      } else {
        await client.joinRoom(code);
      }
      if (this.client === client) {
        this.setState({ screen: 'room', role, code, connection: 'connected' });
      }
    } catch (error) {
      if (this.client !== client) return;
      this.releaseClient();
      this.setState({
        screen: 'home',
        error: describeError(error, role),
        ...(role === 'viewer' ? { enteredCode: code } : {}),
      });
    }
  }

  private releaseClient(): void {
    const client = this.client;
    this.client = null;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    client?.disconnect();
  }

  private setState(state: RoomView): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function describeError(error: unknown, role: Role): string {
  if (error instanceof TrackerRequestError) {
    switch (error.code) {
      case 'SESSION_NOT_FOUND':
        return 'No room was found with that code.';
      case 'SESSION_FULL':
        return 'This room is full.';
      case 'SESSION_ALREADY_EXISTS':
        return 'Could not make a unique room code. Try again.';
      default:
        return role === 'host'
          ? 'Could not create the room. Try again.'
          : 'Could not join the room. Try again.';
    }
  }
  return 'Could not reach the tracker. Check the connection and try again.';
}
