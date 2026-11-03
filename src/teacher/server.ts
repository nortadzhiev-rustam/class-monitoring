// The teacher's side of the LAN: announces the class over UDP, accepts
// authenticated student connections and keeps the class-wide state (lock,
// broadcast) so students who join late are brought in line.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  APP_ID,
  BEACON_INTERVAL_MS,
  DISCOVERY_PORT,
  PROTOCOL_VERSION,
  type Beacon,
  type RtcSignal,
  type StudentInfo,
  type StudentMessage,
  type TeacherMessage,
} from '../shared/protocol';
import { acceptStudent, CLOSE_REPLACED, deriveClassKey, type SecureChannel } from '../shared/secure-channel';
import type { StudentStatus, StudentSummary, TeacherSettings } from './ipc';

export interface ServerConfig extends TeacherSettings {
  port: number;
}

interface Student {
  info: StudentInfo;
  address: string;
  channel: SecureChannel<StudentMessage, TeacherMessage>;
  status: StudentStatus;
  alive: boolean;
}

export interface ServerEvents {
  joined: [StudentSummary];
  left: [string];
  status: [string, StudentStatus];
  thumb: [string, Buffer];
  signal: [string, string, RtcSignal];
  'broadcast-ready': [string, string];
  'student-error': [string, string | undefined, string];
}

const HEARTBEAT_MS = 10_000;
const THUMB_CONFIG = { intervalMs: 2000, width: 480 };

export class ClassServer extends EventEmitter<ServerEvents> {
  private wss: WebSocketServer | null = null;
  private beaconSocket: dgram.Socket | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private classKey: Buffer;
  private readonly students = new Map<string, Student>();

  /** Class-wide state applied to every student, including late joiners. */
  private lockMessage: string | null = null;
  private lockedIds = new Set<string>();
  private broadcastSessionId: string | null = null;

  constructor(private config: ServerConfig) {
    super();
    this.classKey = deriveClassKey(config.classKey);
  }

  get settings(): ServerConfig {
    return { ...this.config };
  }

  get broadcasting(): string | null {
    return this.broadcastSessionId;
  }

  async start(): Promise<void> {
    await this.listen();
    this.startBeacon();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  stop(): void {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.beaconSocket?.close();
    for (const s of this.students.values()) s.channel.close(1001, 'teacher console closed');
    this.wss?.close();
    this.students.clear();
  }

  /** Applies a new room or class key; everyone reconnects with the new settings. */
  async reconfigure(config: ServerConfig): Promise<void> {
    this.stop();
    this.config = config;
    this.classKey = deriveClassKey(config.classKey);
    await this.start();
  }

  list(): StudentSummary[] {
    return [...this.students.values()].map(summary);
  }

  /** IPv4 addresses students can use if broadcast discovery is blocked. */
  addresses(): string[] {
    return lanInterfaces().map((i) => i.address);
  }

  send(id: string, msg: TeacherMessage): void {
    this.students.get(id)?.channel.send(msg);
  }

  lockAll(message: string): void {
    this.lockMessage = message;
    for (const id of this.students.keys()) this.lock(id, message);
  }

  unlockAll(): void {
    this.lockMessage = null;
    for (const id of this.students.keys()) this.unlock(id);
  }

  lock(id: string, message: string): void {
    this.lockedIds.add(id);
    this.send(id, { type: 'lock', message });
  }

  unlock(id: string): void {
    this.lockedIds.delete(id);
    this.send(id, { type: 'unlock' });
  }

  startBroadcast(sessionId: string): void {
    this.broadcastSessionId = sessionId;
    for (const id of this.students.keys()) this.send(id, { type: 'broadcast-start', sessionId });
  }

  stopBroadcast(): void {
    const sessionId = this.broadcastSessionId;
    this.broadcastSessionId = null;
    if (sessionId) for (const id of this.students.keys()) this.send(id, { type: 'broadcast-stop', sessionId });
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.config.port, maxPayload: 16 * 1024 * 1024 });
      wss.once('listening', () => resolve());
      wss.once('error', reject);
      wss.on('connection', (ws, req) => void this.onConnection(ws, req.socket.remoteAddress ?? '?'));
      this.wss = wss;
    });
  }

  private async onConnection(ws: WebSocket, address: string): Promise<void> {
    let channel: SecureChannel<StudentMessage, TeacherMessage>;
    try {
      channel = await acceptStudent(ws, this.classKey, this.config.room);
    } catch (err) {
      console.warn(`[server] rejected ${address}: ${(err as Error).message}`);
      return;
    }

    // The first encrypted message must identify the student.
    channel.onMessage((msg) => {
      if (msg.type !== 'info') {
        channel.close(1008, 'expected info');
        return;
      }
      this.admit(msg.info, address.replace(/^::ffff:/, ''), channel);
    });
  }

  private admit(info: StudentInfo, address: string, channel: SecureChannel<StudentMessage, TeacherMessage>): void {
    const previous = this.students.get(info.id);
    if (previous) {
      // Same machine reconnecting (network blip, restart): drop the stale link.
      this.students.delete(info.id);
      previous.channel.close(CLOSE_REPLACED, 'replaced by a newer connection');
    }

    const student: Student = {
      info,
      address,
      channel,
      status: { locked: false, viewing: false, controlled: false },
      alive: true,
    };
    this.students.set(info.id, student);

    channel.onMessage((msg, payload) => this.onMessage(student, msg, payload));
    channel.onClose(() => {
      if (this.students.get(info.id) !== student) return;
      this.students.delete(info.id);
      this.emit('left', info.id);
    });
    channel.onPong(() => (student.alive = true));

    channel.send({ type: 'welcome', teacher: this.config.teacherName, room: this.config.room });
    channel.send({ type: 'thumb-config', ...THUMB_CONFIG });
    if (this.lockMessage !== null) this.lockedIds.add(info.id);
    if (this.lockedIds.has(info.id)) channel.send({ type: 'lock', message: this.lockMessage ?? '' });
    if (this.broadcastSessionId) channel.send({ type: 'broadcast-start', sessionId: this.broadcastSessionId });

    this.emit('joined', summary(student));
  }

  private onMessage(student: Student, msg: StudentMessage, payload: Buffer | undefined): void {
    const id = student.info.id;
    switch (msg.type) {
      case 'status':
        student.status = { locked: msg.locked, viewing: msg.viewing, controlled: msg.controlled };
        this.emit('status', id, student.status);
        break;
      case 'thumb':
        if (payload) this.emit('thumb', id, payload);
        break;
      case 'signal':
        this.emit('signal', id, msg.sessionId, msg.signal);
        break;
      case 'broadcast-ready':
        if (msg.sessionId === this.broadcastSessionId) this.emit('broadcast-ready', id, msg.sessionId);
        break;
      case 'error':
        console.warn(`[server] ${student.info.hostname}: ${msg.message}`);
        this.emit('student-error', id, msg.sessionId, msg.message);
        break;
      case 'info':
        student.info = msg.info;
        break;
    }
  }

  private heartbeat(): void {
    // A student that missed the last ping is gone (sleep, cable pulled, crash).
    for (const student of this.students.values()) {
      if (!student.alive) {
        student.channel.terminate();
        continue;
      }
      student.alive = false;
      student.channel.ping();
    }
  }

  private startBeacon(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => console.warn('[beacon]', err.message));
    socket.bind(() => {
      socket.setBroadcast(true);
      const send = () => {
        const beacon: Beacon = {
          app: APP_ID,
          v: PROTOCOL_VERSION,
          room: this.config.room,
          port: this.config.port,
          teacher: this.config.teacherName,
        };
        const packet = Buffer.from(JSON.stringify(beacon));
        // Directed broadcasts per interface are more reliable than 255.255.255.255
        // on multi-homed machines; loopback covers a student on this same computer.
        const targets = new Set(['255.255.255.255', '127.0.0.1', ...lanInterfaces().map((i) => i.broadcast)]);
        for (const target of targets) socket.send(packet, DISCOVERY_PORT, target, () => {});
      };
      send();
      this.beaconTimer = setInterval(send, BEACON_INTERVAL_MS);
    });
    this.beaconSocket = socket;
  }
}

function summary(s: Student): StudentSummary {
  return { info: s.info, address: s.address, status: s.status };
}

function lanInterfaces(): Array<{ address: string; broadcast: string }> {
  const result: Array<{ address: string; broadcast: string }> = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      result.push({ address: a.address, broadcast: ip.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.') });
    }
  }
  return result;
}
