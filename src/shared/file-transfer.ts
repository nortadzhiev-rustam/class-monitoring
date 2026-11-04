// Chunked file transfer over the encrypted channel, used both for files the
// teacher hands out and for work students hand in.

import { createHash, randomUUID, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, type FileMessage } from './protocol';

export const CHUNK_BYTES = 256 * 1024;
/** Pause sending while this much is queued, so thumbnails and control stay responsive. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turns a name from the other computer into a safe file name: no folders, no
 * characters Windows or macOS reject, no reserved device names.
 */
export function safeFileName(raw: string): string {
  let name = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'file';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

/** `worksheet.pdf`, then `worksheet (2).pdf`, ... never overwriting. */
export function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export interface FileLink {
  send(msg: FileMessage, payload?: Buffer): void;
  /** Bytes waiting in the socket. */
  buffered(): number;
  open(): boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams one file; resolves once every chunk is queued (the receiver acks separately). */
export async function sendFile(
  link: FileLink,
  filePath: string,
  options: { transferId?: string; collectId?: string; onProgress?: (sent: number, size: number) => void } = {},
): Promise<{ transferId: string; size: number }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`${path.basename(filePath)} is not a file`);
  if (stat.size > LIMITS.fileBytes) throw new Error(`${path.basename(filePath)} is larger than 200 MB`);

  const transferId = options.transferId ?? randomUUID();
  const hash = createHash('sha256');
  const start: FileMessage = { type: 'file-start', transferId, name: path.basename(filePath), size: stat.size };
  if (options.collectId) start.collectId = options.collectId;
  link.send(start);

  let seq = 0;
  let sent = 0;
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: CHUNK_BYTES })) {
    while (link.buffered() > HIGH_WATER_BYTES && link.open()) await sleep(20);
    if (!link.open()) throw new Error('connection lost');
    hash.update(chunk as Buffer);
    link.send({ type: 'file-chunk', transferId, seq: seq++ }, chunk as Buffer);
    sent += (chunk as Buffer).length;
    options.onProgress?.(sent, stat.size);
  }
  link.send({ type: 'file-end', transferId, sha256: hash.digest('hex') });
  return { transferId, size: stat.size };
}

interface Incoming {
  name: string;
  size: number;
  received: number;
  nextSeq: number;
  fd: number;
  tmp: string;
  dir: string;
  hash: Hash;
  collectId?: string;
}

export interface Received {
  path: string;
  name: string;
  size: number;
  collectId?: string;
}

/** Reassembles incoming files; writes to a hidden .part file and renames when verified. */
export class FileReceiver {
  private readonly transfers = new Map<string, Incoming>();

  /** Returns an error message if the file is refused. */
  start(msg: Extract<FileMessage, { type: 'file-start' }>, dir: string): string | null {
    const id = String(msg.transferId);
    if (!/^[\w-]{8,64}$/.test(id) || this.transfers.has(id)) return 'bad transfer id';
    if (!Number.isSafeInteger(msg.size) || msg.size < 0) return 'bad size';
    if (msg.size > LIMITS.fileBytes) return 'file is larger than 200 MB';
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${id}.part`);
    this.transfers.set(id, {
      name: safeFileName(msg.name),
      size: msg.size,
      received: 0,
      nextSeq: 0,
      fd: fs.openSync(tmp, 'w', 0o600),
      tmp,
      dir,
      hash: createHash('sha256'),
      collectId: msg.collectId,
    });
    return null;
  }

  has(transferId: string): boolean {
    return this.transfers.has(transferId);
  }

  /** Returns an error message if the chunk is out of order or too much. */
  chunk(msg: Extract<FileMessage, { type: 'file-chunk' }>, payload: Buffer | undefined): string | null {
    const t = this.transfers.get(msg.transferId);
    if (!t) return 'unknown transfer';
    if (!payload || msg.seq !== t.nextSeq || t.received + payload.length > t.size) {
      this.abort(msg.transferId);
      return 'file arrived damaged';
    }
    fs.writeSync(t.fd, payload);
    t.hash.update(payload);
    t.received += payload.length;
    t.nextSeq++;
    return null;
  }

  end(msg: Extract<FileMessage, { type: 'file-end' }>): Received | { error: string } {
    const t = this.transfers.get(msg.transferId);
    if (!t) return { error: 'unknown transfer' };
    this.transfers.delete(msg.transferId);
    fs.closeSync(t.fd);
    if (t.received !== t.size || t.hash.digest('hex') !== msg.sha256) {
      fs.rmSync(t.tmp, { force: true });
      return { error: 'file arrived damaged' };
    }
    const target = uniquePath(t.dir, t.name);
    fs.renameSync(t.tmp, target);
    return { path: target, name: path.basename(target), size: t.size, collectId: t.collectId };
  }

  abort(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    this.transfers.delete(transferId);
    fs.closeSync(t.fd);
    fs.rmSync(t.tmp, { force: true });
  }

  /** The connection dropped: discard every half-received file. */
  abortAll(): void {
    for (const id of [...this.transfers.keys()]) this.abort(id);
  }
}
