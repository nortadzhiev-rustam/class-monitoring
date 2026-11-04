// Handing files out to students and collecting their work.
//
// Sent files go to each targeted student one after another (students in
// parallel); progress and the student's acknowledgement are reported to the
// console. Collected work is only accepted while a collection is running for
// that student, and lands in Documents/ClassMonitor/Collected/<title>/<student>/.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileReceiver, safeFileName, sendFile } from '../shared/file-transfer';
import { LIMITS, type Collect, type FileMessage } from '../shared/protocol';
import type { Target, TeacherEvent, Transfer } from './ipc';
import type { ClassServer } from './server';

const PROGRESS_EVERY_MS = 250;

export class TeacherFiles {
  private readonly receivers = new Map<string, FileReceiver>();
  /** Sent files waiting for the student's acknowledgement. */
  private readonly outgoing = new Map<string, Transfer>();
  private collecting: (Collect & { folder: string }) | null = null;

  constructor(
    private readonly server: ClassServer,
    private readonly emit: (event: TeacherEvent) => void,
    readonly baseDir: string,
    /** Folder name for a student's collected work. */
    private readonly nameOf: (id: string) => string,
  ) {}

  /** Starts sending in the background; progress arrives as 'transfer' events. */
  send(target: Target, files: string[]): { batchId: string; students: number } {
    const batchId = randomUUID();
    const ids = this.server.onlineIn(target);
    for (const id of ids) void this.sendTo(id, files, batchId);
    return { batchId, students: ids.length };
  }

  private async sendTo(id: string, files: string[], batchId: string): Promise<void> {
    for (const file of files) {
      const transfer: Transfer = { transferId: randomUUID(), batchId, id, name: path.basename(file), size: 0, sent: 0, state: 'sending' };
      const link = this.server.fileLink(id);
      if (!link) {
        this.update(transfer, { state: 'failed', error: 'went offline' });
        continue;
      }
      this.outgoing.set(transfer.transferId, transfer);
      let reported = 0;
      try {
        await sendFile(link, file, {
          transferId: transfer.transferId,
          onProgress: (sent, size) => {
            Object.assign(transfer, { sent, size });
            if (Date.now() - reported < PROGRESS_EVERY_MS) return;
            reported = Date.now();
            this.emit({ type: 'transfer', transfer: { ...transfer } });
          },
        });
      } catch (err) {
        this.outgoing.delete(transfer.transferId);
        this.update(transfer, { state: 'failed', error: (err as Error).message });
      }
    }
  }

  private update(transfer: Transfer, patch: Partial<Transfer>): void {
    Object.assign(transfer, patch);
    this.emit({ type: 'transfer', transfer: { ...transfer } });
  }

  startCollect(title: string): Collect & { folder: string } {
    const clean = title.trim().slice(0, LIMITS.collectTitle) || 'Work';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    const folder = path.join(this.baseDir, 'Collected', safeFileName(`${clean} ${stamp}`));
    fs.mkdirSync(folder, { recursive: true });
    this.collecting = { collectId: randomUUID(), title: clean, folder };
    return { ...this.collecting };
  }

  endCollect(): void {
    this.collecting = null;
  }

  /** True if `folder` is one of ours, so the console only opens folders it created. */
  owns(folder: string): boolean {
    const relative = path.relative(this.baseDir, path.resolve(folder));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  handle(id: string, msg: FileMessage, payload: Buffer | undefined): void {
    const reply = (transferId: string, ok: boolean, error?: string) =>
      this.server.fileLink(id)?.send({ type: 'file-ack', transferId, ok, ...(error ? { error } : {}) });

    switch (msg.type) {
      case 'file-ack': {
        const transfer = this.outgoing.get(msg.transferId);
        if (!transfer || transfer.id !== id) return;
        this.outgoing.delete(msg.transferId);
        if (msg.ok) this.update(transfer, { state: 'done', sent: transfer.size });
        else this.update(transfer, { state: 'failed', error: String(msg.error ?? 'failed').slice(0, 200) });
        break;
      }
      case 'file-start': {
        const c = this.collecting;
        const asked = this.server.policyOf(id).collect;
        if (!c || asked?.collectId !== c.collectId || msg.collectId !== c.collectId) {
          reply(msg.transferId, false, 'Your teacher is not collecting work right now.');
          return;
        }
        const error = this.receiver(id).start(msg, path.join(c.folder, safeFileName(this.nameOf(id))));
        if (error) reply(msg.transferId, false, error);
        break;
      }
      case 'file-chunk': {
        const receiver = this.receiver(id);
        if (!receiver.has(msg.transferId)) return; // Already refused; the student has been told.
        const error = receiver.chunk(msg, payload);
        if (error) reply(msg.transferId, false, error);
        break;
      }
      case 'file-end': {
        const result = this.receiver(id).end(msg);
        if ('error' in result) {
          reply(msg.transferId, false, result.error);
          return;
        }
        reply(msg.transferId, true);
        this.emit({ type: 'collected', id, collectId: result.collectId ?? '', name: result.name, size: result.size });
        break;
      }
    }
  }

  /** The student disconnected: drop half-received work and fail unfinished sends. */
  left(id: string): void {
    this.receivers.get(id)?.abortAll();
    this.receivers.delete(id);
    for (const transfer of [...this.outgoing.values()]) {
      if (transfer.id !== id) continue;
      this.outgoing.delete(transfer.transferId);
      this.update(transfer, { state: 'failed', error: 'went offline' });
    }
  }

  private receiver(id: string): FileReceiver {
    let receiver = this.receivers.get(id);
    if (!receiver) {
      receiver = new FileReceiver();
      this.receivers.set(id, receiver);
    }
    return receiver;
  }
}
