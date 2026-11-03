// Mutual authentication and encryption for the teacher <-> student link.
//
// Both sides share a "class key" (a passphrase deployed to student machines by IT).
// Handshake, in plaintext JSON text frames:
//   teacher -> student  { type: 'challenge', v, nonce: nT, room }
//   student -> teacher  { type: 'auth', v, nonce: nS, mac: HMAC(K, student|nT|nS) }
//   teacher -> student  { type: 'auth-ok', mac: HMAC(K, teacher|nS|nT) }
// Each side proves it knows K without revealing it, so a rogue console cannot
// control students and a rogue agent cannot join the class. Afterwards every
// frame is AES-256-GCM encrypted with per-direction keys derived from K and both
// nonces; a strictly increasing counter is the IV and rejects replays.
//
// WebRTC media is separately encrypted by DTLS-SRTP; its SDP (with the DTLS
// fingerprints) travels inside this channel, so media can't be intercepted either.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { PROTOCOL_VERSION } from './protocol';

const KDF_SALT = 'class-monitor/class-key/v1';
const HANDSHAKE_TIMEOUT_MS = 8000;
const TAG_LENGTH = 16;
const COUNTER_LENGTH = 8;

export const CLOSE_BAD_KEY = 4001;
export const CLOSE_VERSION = 4002;
export const CLOSE_REPLACED = 4003;

/** Keys are case-insensitive so a typed "k7qf2-..." matches the generated "K7QF2-...". */
export function deriveClassKey(passphrase: string): Buffer {
  return scryptSync(passphrase.trim().toUpperCase(), KDF_SALT, 32);
}

/** A random, readable key such as "K7QF2-M9XRA-4TNWP-HB3ZD" (100 bits). */
export function generateClassKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = [...randomBytes(20)].map((b) => alphabet[b & 31]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

function proof(key: Buffer, label: 'student' | 'teacher', a: string, b: string): Buffer {
  return createHmac('sha256', key).update(`${label}\n${a}\n${b}`).digest();
}

function proofMatches(expected: Buffer, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const actual = Buffer.from(received, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionKeys(classKey: Buffer, nT: string, nS: string) {
  const salt = Buffer.concat([Buffer.from(nT, 'base64'), Buffer.from(nS, 'base64')]);
  return {
    teacherToStudent: Buffer.from(hkdfSync('sha256', classKey, salt, 't2s', 32)),
    studentToTeacher: Buffer.from(hkdfSync('sha256', classKey, salt, 's2t', 32)),
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

type Handler<In> = (msg: In, payload: Buffer | undefined) => void;

export class SecureChannel<In, Out> {
  private sendCounter = 0n;
  private recvCounter = 0n;
  private handler: Handler<In> | null = null;
  private queued: Array<[In, Buffer | undefined]> = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {
    ws.on('message', (data, isBinary) => this.receive(data, isBinary));
  }

  /** Messages that arrive before a handler is attached are queued, not dropped. */
  onMessage(handler: Handler<In>): void {
    this.handler = handler;
    for (const [msg, payload] of this.queued.splice(0)) handler(msg, payload);
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.ws.on('close', (code, reason) => handler(code, reason.toString()));
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Bytes queued in the socket, used to skip thumbnails on a slow link. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** Liveness check; `ws` answers pings automatically on the other side. */
  ping(): void {
    if (this.isOpen) this.ws.ping();
  }

  onPong(handler: () => void): void {
    this.ws.on('pong', handler);
  }

  onPing(handler: () => void): void {
    this.ws.on('ping', handler);
  }

  send(msg: Out, payload?: Buffer): void {
    if (!this.isOpen) return;
    const json = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length);
    const plain = payload ? Buffer.concat([header, json, payload]) : Buffer.concat([header, json]);

    this.sendCounter += 1n;
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.sendCounter, 12 - COUNTER_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    this.ws.send(Buffer.concat([iv.subarray(12 - COUNTER_LENGTH), body, cipher.getAuthTag()]));
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  private receive(data: RawData, isBinary: boolean): void {
    try {
      if (!isBinary) throw new Error('unexpected text frame after handshake');
      const frame = toBuffer(data);
      if (frame.length < COUNTER_LENGTH + TAG_LENGTH + 4) throw new Error('short frame');
      const counter = frame.readBigUInt64BE(0);
      if (counter <= this.recvCounter) throw new Error('replayed or reordered frame');

      const iv = Buffer.alloc(12);
      frame.copy(iv, 12 - COUNTER_LENGTH, 0, COUNTER_LENGTH);
      const decipher = createDecipheriv('aes-256-gcm', this.recvKey, iv);
      decipher.setAuthTag(frame.subarray(frame.length - TAG_LENGTH));
      const plain = Buffer.concat([
        decipher.update(frame.subarray(COUNTER_LENGTH, frame.length - TAG_LENGTH)),
        decipher.final(),
      ]);
      this.recvCounter = counter;

      const jsonLength = plain.readUInt32BE(0);
      const msg = JSON.parse(plain.subarray(4, 4 + jsonLength).toString('utf8')) as In;
      const payload = plain.length > 4 + jsonLength ? plain.subarray(4 + jsonLength) : undefined;
      if (this.handler) this.handler(msg, payload);
      else this.queued.push([msg, payload]);
    } catch (err) {
      console.warn('[secure-channel] dropping connection:', (err as Error).message);
      this.ws.terminate();
    }
  }
}

/**
 * Runs `step` for each handshake text frame until it returns a result.
 * The listener is removed synchronously so the SecureChannel created inside
 * `step` sees every following frame.
 */
function handshake<T>(ws: WebSocket, step: (msg: Record<string, unknown>) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new Error('handshake timed out'));
      ws.terminate();
    }, HANDSHAKE_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) throw new Error('unexpected binary frame during handshake');
        const result = step(JSON.parse(toBuffer(data).toString('utf8')));
        if (result !== undefined) {
          cleanup();
          resolve(result);
        }
      } catch (err) {
        fail(err as Error);
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      const text = reason.toString();
      fail(new Error(code === CLOSE_BAD_KEY ? 'class key rejected by teacher' : `closed during handshake (${code} ${text})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/** Teacher side: challenge a newly connected student. */
export function acceptStudent<In, Out>(ws: WebSocket, classKey: Buffer, room: string): Promise<SecureChannel<In, Out>> {
  const nT = randomBytes(16).toString('base64');
  const result = handshake(ws, (msg) => {
    if (msg.type !== 'auth') throw new Error('expected auth');
    if (msg.v !== PROTOCOL_VERSION) {
      ws.close(CLOSE_VERSION, 'protocol version mismatch');
      throw new Error(`student speaks protocol v${msg.v}`);
    }
    const nS = String(msg.nonce);
    if (!proofMatches(proof(classKey, 'student', nT, nS), msg.mac)) {
      ws.close(CLOSE_BAD_KEY, 'bad class key');
      throw new Error('student used the wrong class key');
    }
    ws.send(JSON.stringify({ type: 'auth-ok', mac: proof(classKey, 'teacher', nS, nT).toString('base64') }));
    const keys = sessionKeys(classKey, nT, nS);
    return new SecureChannel<In, Out>(ws, keys.teacherToStudent, keys.studentToTeacher);
  });
  ws.send(JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: nT, room }));
  return result;
}

/** Student side: answer the teacher's challenge and verify the teacher in return. */
export function connectToTeacher<In, Out>(ws: WebSocket, classKey: Buffer): Promise<SecureChannel<In, Out>> {
  const nS = randomBytes(16).toString('base64');
  let nT = '';
  return handshake(ws, (msg) => {
    if (msg.type === 'challenge') {
      if (msg.v !== PROTOCOL_VERSION) throw new Error(`teacher speaks protocol v${msg.v}`);
      nT = String(msg.nonce);
      const mac = proof(classKey, 'student', nT, nS).toString('base64');
      ws.send(JSON.stringify({ type: 'auth', v: PROTOCOL_VERSION, nonce: nS, mac }));
      return undefined;
    }
    if (msg.type === 'auth-ok' && nT) {
      if (!proofMatches(proof(classKey, 'teacher', nS, nT), msg.mac)) {
        ws.terminate();
        throw new Error('teacher failed authentication (wrong class key?)');
      }
      const keys = sessionKeys(classKey, nT, nS);
      return new SecureChannel<In, Out>(ws, keys.studentToTeacher, keys.teacherToStudent);
    }
    throw new Error(`unexpected handshake message ${String(msg.type)}`);
  });
}
