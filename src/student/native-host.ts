// When Chrome or Edge starts the student app for the web filter extension
// ("native messaging"), it runs in this mode instead of as the agent: it
// relays between the browser (length-prefixed JSON on stdin/stdout) and the
// agent that is already running (a local socket), and exits when either side
// goes away. Nothing may be printed to stdout here except messages.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Chrome passes the calling extension's origin as an argument; the dev launcher adds --native-host. */
export function isNativeHostLaunch(argv: string[]): boolean {
  return argv.some((a) => a.startsWith('chrome-extension://')) || argv.includes('--native-host');
}

/** One socket per student profile, short enough for the 104-character Unix socket limit. */
export function bridgeSocketPath(userData: string): string {
  const tag = createHash('sha256').update(userData).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\classmonitor-web-${tag}` : path.join(os.tmpdir(), `classmonitor-web-${tag}.sock`);
}

/** Proves to the agent that the host was started for this user; readable only by them. */
export const bridgeSecretPath = (userData: string) => path.join(userData, 'web-bridge-secret');

export function runNativeHost(userData: string): void {
  let secret: string;
  try {
    secret = fs.readFileSync(bridgeSecretPath(userData), 'utf8').trim();
  } catch {
    process.exit(1); // The student app has never run for this user.
  }
  const quit = () => process.exit(0);
  const socket = net.connect(bridgeSocketPath(userData));
  socket.on('error', quit);
  socket.on('close', quit);
  socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'auth', secret })}\n`));

  // Agent -> browser: one JSON object per line.
  let lines = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    lines += chunk;
    for (let nl = lines.indexOf('\n'); nl >= 0; nl = lines.indexOf('\n')) {
      const line = lines.slice(0, nl);
      lines = lines.slice(nl + 1);
      if (line) writeMessage(line);
    }
  });

  // Browser -> agent: 32-bit length in native byte order (little-endian on
  // Windows and macOS), then that many bytes of JSON.
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) quit();
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      try {
        socket.write(`${JSON.stringify(JSON.parse(body))}\n`);
      } catch {
        // Not JSON: ignore it.
      }
    }
  });
  process.stdin.on('end', quit);
}

function writeMessage(json: string): void {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
