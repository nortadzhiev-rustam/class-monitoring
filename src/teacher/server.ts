// The teacher's side of the LAN: announces the class over UDP, accepts
// authenticated student connections and keeps every student's policy (lock,
// broadcast, ...) so students who reconnect or join late are brought in line.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  APP_ID,
  BEACON_INTERVAL_MS,
  DISCOVERY_PORT,
  LIMITS,
  PROTOCOL_VERSION,
  type Beacon,
  type FileMessage,
  type Platform,
  type Policy,
  type RtcSignal,
  type StudentInfo,
  type StudentMessage,
  type TeacherMessage,
} from '../shared/protocol';
import type { FileLink } from '../shared/file-transfer';
import { acceptStudent, CLOSE_REPLACED, deriveClassKey, type SecureChannel } from '../shared/secure-channel';
import type { StudentStatus, StudentSummary, Target, TeacherSettings } from './ipc';
import { PolicyTable } from './policy';

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
  policy: [string, Policy];
  chat: [string, { id: string; text: string; at: number }];
  'poll-answer': [string, string, number];
  'sign-in': [string, string, string];
  file: [string, FileMessage, Buffer | undefined];
  /** A computer at this address tried to join with a different protocol version. */
  'version-mismatch': [string];
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
  private readonly policies = new PolicyTable();

  constructor(private config: ServerConfig) {
    super();
    this.classKey = deriveClassKey(config.classKey);
  }

  get settings(): ServerConfig {
    return { ...this.config };
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
    this.policies.reset();
    this.config = config;
    this.classKey = deriveClassKey(config.classKey);
    await this.start();
  }

  list(): StudentSummary[] {
    return [...this.students.values()].map((s) => this.summary(s));
  }

  /** IPv4 addresses students can use if broadcast discovery is blocked. */
  addresses(): string[] {
    return lanInterfaces().map((i) => i.address);
  }

  send(id: string, msg: TeacherMessage): void {
    this.students.get(id)?.channel.send(msg);
  }

  /** Changes settings for the target and pushes the new policy to those online. */
  setPolicy(target: Target, patch: Partial<Policy>): void {
    // "Everyone" includes students who connected after the console built the target.
    const ids = target.everyone ? [...new Set([...target.ids, ...this.students.keys()])] : target.ids;
    this.pushPolicy(this.policies.apply({ ids, everyone: target.everyone }, patch));
  }

  /** Turns a setting off for everyone it was on for (ends the broadcast, the poll, ...). */
  clearPolicy(key: keyof Policy): void {
    this.pushPolicy(this.policies.clear(key, this.students.keys()));
  }

  policyOf(id: string): Policy {
    return this.policies.get(id);
  }

  /** Connected students among the target ("everyone" means everyone connected). */
  onlineIn(target: Target): string[] {
    return target.everyone ? [...this.students.keys()] : target.ids.filter((id) => this.students.has(id));
  }

  /** A file-sending handle for one connected student. */
  fileLink(id: string): FileLink | null {
    const student = this.students.get(id);
    if (!student) return null;
    const { channel } = student;
    return {
      send: (msg, payload) => channel.send(msg, payload),
      buffered: () => channel.bufferedAmount,
      open: () => channel.isOpen && this.students.get(id) === student,
    };
  }

  /** Sends to every connected student in the target; returns how many got it. */
  sendTo(target: Target, msg: TeacherMessage): number {
    const ids = target.everyone ? [...this.students.keys()] : target.ids;
    let sent = 0;
    for (const id of ids) {
      const student = this.students.get(id);
      if (!student) continue;
      student.channel.send(msg);
      sent++;
    }
    return sent;
  }

  private summary(s: Student): StudentSummary {
    return { info: s.info, address: s.address, status: s.status, policy: this.policies.get(s.info.id) };
  }

  private pushPolicy(ids: string[]): void {
    for (const id of ids) {
      const policy = this.policies.get(id);
      this.send(id, { type: 'policy', policy });
      this.emit('policy', id, policy);
    }
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
      const message = (err as Error).message;
      console.warn(`[server] rejected ${address}: ${message}`);
      if (/protocol v/.test(message)) this.emit('version-mismatch', address.replace(/^::ffff:/, ''));
      return;
    }

    // The first encrypted message must identify the student.
    channel.onMessage((msg) => {
      if (msg.type !== 'info') {
        channel.close(1008, 'expected info');
        return;
      }
      const info = sanitizeInfo(msg.info);
      if (!info) {
        channel.close(1008, 'invalid info');
        return;
      }
      this.admit(info, address.replace(/^::ffff:/, ''), channel);
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
      status: { locked: false, viewing: false, controlled: false, hand: null },
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
    channel.send({ type: 'policy', policy: this.policies.get(info.id) });

    this.emit('joined', this.summary(student));
  }

  private onMessage(student: Student, msg: StudentMessage, payload: Buffer | undefined): void {
    const id = student.info.id;
    switch (msg.type) {
      case 'status':
        student.status = {
          locked: msg.locked === true,
          viewing: msg.viewing === true,
          controlled: msg.controlled === true,
          hand: typeof msg.hand === 'string' ? msg.hand.slice(0, LIMITS.handNote) : null,
        };
        this.emit('status', id, student.status);
        break;
      case 'chat':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          this.emit('chat', id, { id: String(msg.id).slice(0, 64), text: msg.text.slice(0, LIMITS.chat), at: Date.now() });
        }
        break;
      case 'sign-in': {
        const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, LIMITS.name) : '';
        if (name && msg.registerId === this.policies.get(id).register) this.emit('sign-in', id, msg.registerId, name);
        break;
      }
      case 'file-start':
      case 'file-chunk':
      case 'file-end':
      case 'file-ack':
        this.emit('file', id, msg, payload);
        break;
      case 'poll-answer': {
        const poll = this.policies.get(id).poll;
        if (poll && msg.pollId === poll.pollId && Number.isInteger(msg.choice) && msg.choice >= 0 && msg.choice < poll.choices.length) {
          this.emit('poll-answer', id, msg.pollId, msg.choice);
        }
        break;
      }
      case 'thumb':
        if (payload) this.emit('thumb', id, payload);
        break;
      case 'signal':
        this.emit('signal', id, msg.sessionId, msg.signal);
        break;
      case 'broadcast-ready':
        if (msg.sessionId === this.policies.get(id).broadcast) this.emit('broadcast-ready', id, msg.sessionId);
        break;
      case 'error':
        console.warn(`[server] ${student.info.hostname}: ${msg.message}`);
        this.emit('student-error', id, msg.sessionId, msg.message);
        break;
      case 'info': {
        const info = sanitizeInfo(msg.info);
        if (info && info.id === id) student.info = info;
        break;
      }
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

const PLATFORMS: Platform[] = ['darwin', 'win32', 'linux'];
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Student-supplied identity is untrusted: keep only well-formed, bounded fields. */
function sanitizeInfo(raw: StudentInfo): StudentInfo | null {
  if (!raw || typeof raw.id !== 'string' || !/^[\w-]{8,64}$/.test(raw.id)) return null;
  const dim = (n: unknown) => (Number.isFinite(n) ? Math.max(0, Math.min(100_000, Number(n))) : 0);
  return {
    id: raw.id,
    hostname: text(raw.hostname, 80) || 'Unknown computer',
    username: text(raw.username, 80),
    platform: PLATFORMS.includes(raw.platform) ? raw.platform : 'linux',
    screen: { width: dim(raw.screen?.width), height: dim(raw.screen?.height) },
    macs: (Array.isArray(raw.macs) ? raw.macs : []).filter((m) => typeof m === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m)).slice(0, 8),
    version: text(raw.version, 20),
  };
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
