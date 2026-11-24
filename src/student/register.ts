// Attendance register: while the teacher has one open, the student signs in
// with their name. The name is kept for further registers while this computer
// stays connected to the teacher, and forgotten when the connection ends
// (the teacher closes the console, the computer restarts or drops off the
// network), since the next lesson may be someone else's at this computer.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../shared/protocol';
import { findPrompt, onPromptAction, removePrompt, removePrompts, showPrompt } from './prompts';
import { send, state } from './state';

const signedIn = new Set<string>();
let osName: Promise<string> | null = null;
/** The name typed in this connection's registers, offered again in the next one. */
let sessionName = '';

/** The teacher went away: the next sign-in starts from the account's name again. */
export function forgetSignIn(): void {
  sessionName = '';
  signedIn.clear();
}

// Earlier versions kept the name on disk for every later lesson; drop it.
app.whenReady().then(() => fs.rm(path.join(app.getPath('userData'), 'profile.json'), { force: true }, () => {}));

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
  const name = sessionName || (await accountName());
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
  sessionName = name;
  showPrompt({ ...card, name, done: true, error: null });
  setTimeout(() => removePrompt(card.id), 4000);
});
