// Opening a website or an app on the student's computer at the teacher's request.

import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { APP_NAME, LIMITS } from '../shared/protocol';
import { send } from './state';

/** Testing: log what would open instead of opening it. */
const DRY_RUN = process.env.CM_LAUNCH_DRY_RUN === '1';

const fail = (message: string) => send({ type: 'error', message });

export function openUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(String(raw).slice(0, LIMITS.url));
  } catch {
    fail("That web address doesn't look right.");
    return;
  }
  // Only web pages: never file:, javascript: or custom app links.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('Only http and https addresses can be opened.');
    return;
  }
  if (DRY_RUN) console.log(`[launch] url ${url.href}`);
  else void shell.openExternal(url.href);
}

export function openApp(raw: string): void {
  const name = String(raw).trim();
  if (!APP_NAME.test(name) || name.includes('*')) {
    fail(`"${name.slice(0, 60)}" isn't a valid app name.`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[launch] app ${name}`);
    return;
  }
  const done = (err: Error | null) => err && fail(`Couldn't find an app called "${name}" on this computer.`);
  if (process.platform === 'darwin') {
    execFile('open', ['-a', name], done);
  } else if (process.platform === 'win32') {
    // The name goes in an environment variable, never into the command text.
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:CM_APP'],
      { env: { ...process.env, CM_APP: name }, windowsHide: true },
      done,
    );
  } else {
    fail('Opening apps is only supported on Windows and macOS.');
  }
}
