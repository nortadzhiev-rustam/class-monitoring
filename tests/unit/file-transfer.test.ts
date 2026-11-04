import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CHUNK_BYTES, FileReceiver, safeFileName, sendFile, uniquePath, type Received } from '../../src/shared/file-transfer';
import type { FileMessage } from '../../src/shared/protocol';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-'));

test('file names from the other computer are made safe', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\x\\essay.docx'), 'essay.docx');
  assert.equal(safeFileName('what?<now>.txt'), 'what__now_.txt');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('trailing. . '), 'trailing');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.ok(safeFileName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf'));
  assert.equal(safeFileName(`${'a'.repeat(300)}.pdf`).length, 120);
});

test('existing files are never overwritten', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), '1');
  fs.writeFileSync(path.join(dir, 'notes (2).txt'), '2');
  assert.equal(uniquePath(dir, 'notes.txt'), path.join(dir, 'notes (3).txt'));
  assert.equal(uniquePath(dir, 'fresh.txt'), path.join(dir, 'fresh.txt'));
});

test('a multi-chunk file arrives byte-identical', async () => {
  const source = path.join(tmpDir(), 'data.bin');
  const bytes = randomBytes(CHUNK_BYTES * 2 + 123);
  fs.writeFileSync(source, bytes);
  const dest = tmpDir();
  const receiver = new FileReceiver();
  let result: Received | { error: string } | null = null;

  await sendFile(
    {
      send: (msg: FileMessage, payload?: Buffer) => {
        if (msg.type === 'file-start') assert.equal(receiver.start(msg, dest), null);
        if (msg.type === 'file-chunk') assert.equal(receiver.chunk(msg, payload), null);
        if (msg.type === 'file-end') result = receiver.end(msg);
      },
      buffered: () => 0,
      open: () => true,
    },
    source,
  );

  assert.ok(result && 'path' in result);
  const received = result as Received;
  assert.equal(received.name, 'data.bin');
  assert.deepEqual(fs.readFileSync(received.path), bytes);
  assert.deepEqual(fs.readdirSync(dest), ['data.bin']); // no .part left behind
});

test('a corrupted or out-of-order file is rejected and cleaned up', () => {
  const dest = tmpDir();
  const receiver = new FileReceiver();
  assert.equal(receiver.start({ type: 'file-start', transferId: 'transfer-1', name: 'x.txt', size: 4 }, dest), null);
  assert.equal(receiver.chunk({ type: 'file-chunk', transferId: 'transfer-1', seq: 1 }, Buffer.from('ab')), 'file arrived damaged');
  assert.deepEqual(fs.readdirSync(dest), []);

  assert.equal(receiver.start({ type: 'file-start', transferId: 'transfer-2', name: 'y.txt', size: 2 }, dest), null);
  assert.equal(receiver.chunk({ type: 'file-chunk', transferId: 'transfer-2', seq: 0 }, Buffer.from('ab')), null);
  assert.deepEqual(receiver.end({ type: 'file-end', transferId: 'transfer-2', sha256: 'wrong' }), { error: 'file arrived damaged' });
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('oversized files are refused before anything is written', () => {
  const receiver = new FileReceiver();
  const dest = tmpDir();
  assert.match(receiver.start({ type: 'file-start', transferId: 'transfer-3', name: 'big.iso', size: 300 * 1024 * 1024 }, dest) ?? '', /200 MB/);
  assert.deepEqual(fs.readdirSync(dest), []);
});
