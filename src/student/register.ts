// Attendance register: while the teacher has one open, the student signs in
// with their name. The name is remembered for next time.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../shared/protocol';
import { findPrompt, onPromptAction, removePrompt, removePrompts, showPrompt } from './prompts';
import { send, state } from './state';

const signedIn = new Set<string>();
let osName: Promise<string> | null = null;

const profileFile = () => path.join(app.getPath('userData'), 'profile.json');

function savedName(): string {
  try {
    return String(JSON.parse(fs.readFileSync(profileFile(), 'utf8')).name ?? '');
  } catch {
    return '';
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

/** The account's full name, as a first guess: macOS `id -F`, or the CN of a Windows domain account. */
function accountName(): Promise<string> {
  osName ??= (async () => {
    if (process.platform === 'darwin') return run('id', ['-F']);
    if (process.platform === 'win32') return /CN=([^,]+)/.exec(await run('whoami', ['/fqdn']))?.[1]?.trim() ?? '';
    return '';
  })();
  return osName;
}

/** Shows or clears the sign-in card to match the teacher's policy. */
export async function showRegister(registerId: string | null): Promise<void> {
  removePrompts((c) => c.kind === 'sign-in' && c.registerId !== registerId);
  if (!registerId || signedIn.has(registerId) || findPrompt(`register-${registerId}`)) return;
  const name = savedName() || (await accountName());
  showPrompt({
    id: `register-${registerId}`,
    kind: 'sign-in',
    registerId,
    from: state.teacher?.name ?? 'Your teacher',
    name: name.slice(0, LIMITS.name),
    done: false,
    error: null,
  });
}

onPromptAction('sign-in', (card, action, value) => {
  if (card.kind !== 'sign-in' || action !== 'submit' || card.done) return;
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, LIMITS.name);
  if (!name) {
    showPrompt({ ...card, error: 'Type your name to sign in.' });
    return;
  }
  send({ type: 'sign-in', registerId: card.registerId, name });
  signedIn.add(card.registerId);
  try {
    fs.writeFileSync(profileFile(), JSON.stringify({ name }));
  } catch {
    // Not remembered; the student just types it again next time.
  }
  showPrompt({ ...card, name, done: true, error: null });
  setTimeout(() => removePrompt(card.id), 4000);
});
