// Finds the teacher (UDP beacons, or a fixed teacherHost) and keeps one
// authenticated connection open, reconnecting after drops.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  APP_ID,
  DISCOVERY_PORT,
  PROTOCOL_VERSION,
  type Beacon,
  type StudentInfo,
  type StudentMessage,
  type TeacherMessage,
} from '../shared/protocol';
import { connectToTeacher, deriveClassKey, type SecureChannel } from '../shared/secure-channel';
import type { StudentConfig } from './config';

interface LinkEvents {
  connected: [{ teacher: string; room: string; host: string }];
  disconnected: [];
  message: [TeacherMessage, Buffer | undefined];
  error: [string];
}

const DIRECT_RETRY_MS = 3000;
/** After a failed handshake, ignore that teacher for a while instead of hammering it. */
const BACKOFF_MS = 30_000;
/** The teacher pings every 10 s; silence this long means the link is dead. */
const SILENCE_LIMIT_MS = 30_000;

export class TeacherLink extends EventEmitter<LinkEvents> {
  private channel: SecureChannel<TeacherMessage, StudentMessage> | null = null;
  private connecting = false;
  private readonly classKey: Buffer;
  private readonly backoff = new Map<string, number>();
  private socket: dgram.Socket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastHeard = 0;

  constructor(
    private readonly config: StudentConfig,
    private readonly info: () => StudentInfo,
  ) {
    super();
    this.classKey = deriveClassKey(config.classKey);
  }

  get connected(): boolean {
    return this.channel?.isOpen ?? false;
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  start(): void {
    this.listenForBeacons();
    const { teacherHost, teacherPort } = this.config;
    if (teacherHost) {
      const tryDirect = () => void this.connect(teacherHost, teacherPort);
      tryDirect();
      this.timers.push(setInterval(tryDirect, DIRECT_RETRY_MS));
    }
    this.timers.push(
      setInterval(() => {
        if (this.channel && Date.now() - this.lastHeard > SILENCE_LIMIT_MS) this.channel.terminate();
      }, 5000),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.socket?.close();
    this.channel?.close(1001, 'student agent closed');
  }

  send(msg: StudentMessage, payload?: Buffer): void {
    this.channel?.send(msg, payload);
  }

  private listenForBeacons(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => console.warn('[discovery]', err.message));
    socket.on('message', (data, rinfo) => {
      let beacon: Beacon;
      try {
        beacon = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (beacon.app !== APP_ID || beacon.v !== PROTOCOL_VERSION || beacon.room !== this.config.room) return;
      void this.connect(rinfo.address, Number(beacon.port));
    });
    socket.bind(DISCOVERY_PORT);
    this.socket = socket;
  }

  private async connect(host: string, port: number): Promise<void> {
    const key = `${host}:${port}`;
    if (this.channel || this.connecting || (this.backoff.get(key) ?? 0) > Date.now()) return;
    this.connecting = true;

    const ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    ws.on('error', () => {}); // Reported through the handshake's close handling.
    try {
      const channel = await connectToTeacher<TeacherMessage, StudentMessage>(ws, this.classKey);
      this.channel = channel;
      this.lastHeard = Date.now();
      channel.onPing(() => (this.lastHeard = Date.now()));
      channel.onClose(() => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.emit('disconnected');
      });
      channel.onMessage((msg, payload) => {
        this.lastHeard = Date.now();
        if (msg.type === 'welcome') this.emit('connected', { teacher: msg.teacher, room: msg.room, host });
        this.emit('message', msg, payload);
      });
      channel.send({ type: 'info', info: this.info() });
    } catch (err) {
      const message = (err as Error).message;
      if (!/ECONNREFUSED|closed during handshake \(1006/.test(message)) {
        console.warn(`[link] ${key}: ${message}`);
        this.emit('error', message);
      }
      if (/key|authentication|protocol/.test(message)) this.backoff.set(key, Date.now() + BACKOFF_MS);
    } finally {
      this.connecting = false;
    }
  }
}
