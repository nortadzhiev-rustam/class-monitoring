import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { acceptStudent, connectToTeacher, deriveClassKey, generateClassKey, type SecureChannel } from '../../src/shared/secure-channel';

type Channel = SecureChannel<{ n: number }, { n: number }>;

/** Runs a teacher/student handshake over a real localhost WebSocket. */
async function pair(teacherKey: string, studentKey: string) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const teacherSide = new Promise<Channel>((resolve, reject) => {
    wss.once('connection', (ws) => acceptStudent<{ n: number }, { n: number }>(ws, deriveClassKey(teacherKey), 'Room').then(resolve, reject));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const studentSide = connectToTeacher<{ n: number }, { n: number }>(ws, deriveClassKey(studentKey));
  const close = () => {
    ws.terminate();
    wss.close();
  };
  return { teacherSide, studentSide, close };
}

test('matching keys connect and messages round-trip with payloads', async () => {
  const { teacherSide, studentSide, close } = await pair('Class-Key-123', 'class-key-123');
  try {
    const [teacher, student] = await Promise.all([teacherSide, studentSide]);
    const received = new Promise<[{ n: number }, Buffer | undefined]>((resolve) => teacher.onMessage((m, p) => resolve([m, p])));
    student.send({ n: 42 }, Buffer.from('jpeg bytes'));
    const [msg, payload] = await received;
    assert.deepEqual(msg, { n: 42 });
    assert.equal(payload?.toString(), 'jpeg bytes');
  } finally {
    close();
  }
});

test('a wrong class key is rejected on both sides', async () => {
  const { teacherSide, studentSide, close } = await pair('right-key-123', 'wrong-key-456');
  try {
    await assert.rejects(teacherSide, /wrong class key/);
    await assert.rejects(studentSide, /class key rejected/);
  } finally {
    close();
  }
});

test('generated keys are readable and unambiguous', () => {
  const key = generateClassKey();
  assert.match(key, /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
  assert.notEqual(generateClassKey(), key);
});
