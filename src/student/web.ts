// The student app's side of the web filter. The browser extension reaches it
// through its native-messaging host (see native-host.ts), which connects to a
// local socket here and must present a secret only this user can read. Rules
// go down to the extension; the student's current site comes back up and is
// reported to the teacher, along with whether the extension is there at all.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { programNames } from '../shared/app-match';
import type { WebStatus } from '../shared/protocol';
import { DEV_EXTENSION_ID, EXTENSION_ID, NATIVE_HOST, type WebRules } from '../shared/web-rules';
import { runningProcesses } from './app-blocker';
import { bridgeSecretPath, bridgeSocketPath } from './native-host';
import { send } from './state';

const BROWSER_CHECK_MS = 10_000;
const CHROMIUM_BROWSERS = ['google chrome', 'chrome', 'msedge', 'microsoft edge'];

let rules: WebRules | null = null;
const clients = new Set<net.Socket>();
let status: WebStatus = { extension: false, browserOpen: false, url: null, title: null };
let lastReported = '';
let reportTimer: NodeJS.Timeout | null = null;
let browserTimer: NodeJS.Timeout | null = null;

export function startWebBridge(userData: string): void {
  const secret = ensureSecret(userData);
  const socketPath = bridgeSocketPath(userData);
  if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => accept(socket, secret));
  server.on('error', (err) => console.warn('[web] bridge unavailable:', err.message));
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  });
}

function ensureSecret(userData: string): string {
  const file = bridgeSecretPath(userData);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // First run: create it below.
  }
  const secret = randomBytes(32).toString('hex');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function write(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function accept(socket: net.Socket, secret: string): void {
  let authed = false;
  let lines = '';
  const deadline = setTimeout(() => socket.destroy(), 5000);
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(deadline);
    if (clients.delete(socket) && !clients.size) update({ extension: false, url: null, title: null });
  });
  socket.on('data', (chunk: string) => {
    lines += chunk;
    if (lines.length > 1_000_000) {
      socket.destroy();
      return;
    }
    for (let nl = lines.indexOf('\n'); nl >= 0; nl = lines.indexOf('\n')) {
      const line = lines.slice(0, nl);
      lines = lines.slice(nl + 1);
      let message: { type?: string; secret?: unknown; url?: unknown; title?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!authed) {
        const given = Buffer.from(String(message.secret ?? ''));
        const expected = Buffer.from(secret);
        if (message.type !== 'auth' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
          socket.destroy();
          return;
        }
        authed = true;
        clearTimeout(deadline);
        clients.add(socket);
        write(socket, { type: 'rules', rules });
        continue;
      }
      if (message.type === 'hello') {
        update({ extension: true });
      } else if (message.type === 'tab') {
        // Only real web pages are reported; new-tab and settings pages show as nothing.
        const url = typeof message.url === 'string' && /^https?:\/\//.test(message.url) ? message.url.slice(0, 2000) : null;
        const title = url && typeof message.title === 'string' ? message.title.slice(0, 200) : null;
        update({ extension: true, url, title });
      }
    }
  });
}

/** The teacher's website rules changed (null: open browsing). */
export function setWebRules(next: WebRules | null): void {
  rules = next;
  for (const socket of clients) write(socket, { type: 'rules', rules });
  if (rules && !browserTimer) {
    browserTimer = setInterval(() => void checkBrowser(), BROWSER_CHECK_MS);
    void checkBrowser();
  } else if (!rules && browserTimer) {
    clearInterval(browserTimer);
    browserTimer = null;
    update({ browserOpen: false });
  }
}

/** While rules are on, notice Chrome/Edge running without the extension. */
async function checkBrowser(): Promise<void> {
  const names = (await runningProcesses()).flatMap((p) => programNames(p.path));
  update({ browserOpen: names.some((n) => CHROMIUM_BROWSERS.includes(n)) });
}

function update(patch: Partial<WebStatus>): void {
  status = { ...status, ...patch };
  reportTimer ??= setTimeout(() => {
    reportTimer = null;
    reportWebStatus();
  }, 300);
}

/** Tells the teacher about the browser; `force` after reconnecting. */
export function reportWebStatus(force = false): void {
  const json = JSON.stringify(status);
  if (!force && json === lastReported) return;
  lastReported = json;
  send({ type: 'web', ...status });
}

// ---------------------------------------------------------------- registration

/**
 * Tells Chrome and Edge where the native-messaging host is, for this user only
 * (no admin rights needed). Packaged builds point at the app itself; in
 * development a launcher script runs Electron with this project.
 */
export function registerNativeHost(userData: string, extensionIds: string[]): void {
  const ids = [...new Set([DEV_EXTENSION_ID, ...extensionIds])].filter((id) => EXTENSION_ID.test(id));
  const manifest = JSON.stringify(
    {
      name: NATIVE_HOST,
      description: 'ClassMonitor Student (bridge for the web filter extension)',
      path: app.isPackaged ? process.execPath : devLauncher(userData),
      type: 'stdio',
      allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  );
  try {
    if (process.platform === 'darwin') {
      const support = path.join(os.homedir(), 'Library', 'Application Support');
      for (const browser of ['Google/Chrome', 'Microsoft Edge', 'Chromium']) {
        const dir = path.join(support, browser, 'NativeMessagingHosts');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${NATIVE_HOST}.json`), manifest);
      }
    } else if (process.platform === 'win32') {
      const file = path.join(userData, `${NATIVE_HOST}.json`);
      fs.writeFileSync(file, manifest);
      for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) {
        const key = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${NATIVE_HOST}`;
        execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true }, () => {});
      }
    }
  } catch (err) {
    console.warn('[web] could not register with the browsers:', (err as Error).message);
  }
}

function devLauncher(userData: string): string {
  const main = path.join(__dirname, 'main.js');
  if (process.platform === 'win32') {
    const file = path.join(userData, 'native-host.bat');
    fs.writeFileSync(file, `@set CM_USER_DATA=${userData}\r\n@"${process.execPath}" "${main}" --native-host %*\r\n`);
    return file;
  }
  const file = path.join(userData, 'native-host.sh');
  fs.writeFileSync(file, `#!/bin/sh\nexport CM_USER_DATA='${userData}'\nexec '${process.execPath}' '${main}' --native-host "$@"\n`, { mode: 0o755 });
  return file;
}
