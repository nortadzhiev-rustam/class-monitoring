// Closes blocked apps while the teacher's list is on: checks the student's own
// running programs every 2 seconds. It has no admin rights, so it can only
// touch programs the student started.

import { execFile } from 'node:child_process';
import { blockedBy, displayName } from '../shared/app-match';
import { APP_NAME, LIMITS } from '../shared/protocol';
import { onPromptAction, removePrompt, showPrompt } from './prompts';
import { send } from './state';

const SWEEP_MS = 2000;
/** Tell the teacher about the same app at most this often. */
const REPORT_EVERY_MS = 30_000;

let blocked: string[] = [];
let timer: NodeJS.Timeout | null = null;
let sweeping = false;
const reported = new Map<string, number>();

export function setBlockedApps(list: string[] | null): void {
  blocked = (list ?? []).filter((name) => typeof name === 'string' && APP_NAME.test(name)).slice(0, LIMITS.blockedApps);
  if (blocked.length && !timer) {
    timer = setInterval(() => void sweep(), SWEEP_MS);
    void sweep();
  } else if (!blocked.length && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const blockedApps = () => blocked;

onPromptAction('notice', (card, action) => {
  if (action === 'dismiss') removePrompt(card.id);
});

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** The current user's running programs. */
async function processes(): Promise<Array<{ pid: number; path: string }>> {
  if (process.platform === 'win32') {
    // "steam.exe","1234","Console","1","50,000 K"
    const out = await run('tasklist', ['/fo', 'csv', '/nh', '/fi', `USERNAME eq ${process.env.USERNAME ?? ''}`]);
    return out
      .split(/\r?\n/)
      .map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/g, '')))
      .filter((cells) => cells.length >= 2 && /^\d+$/.test(cells[1]))
      .map((cells) => ({ pid: Number(cells[1]), path: cells[0] }));
  }
  const out = await run('ps', ['-x', '-o', 'pid=,comm=']);
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), path: m[2].trim() }));
}

async function sweep(): Promise<void> {
  if (sweeping || !blocked.length) return;
  sweeping = true;
  try {
    for (const p of await processes()) {
      if (p.pid === process.pid || p.pid === process.ppid || !blockedBy(p.path, blocked)) continue;
      try {
        process.kill(p.pid);
      } catch {
        continue; // Already gone, or not ours to close.
      }
      closed(displayName(p.path));
    }
  } finally {
    sweeping = false;
  }
}

function closed(name: string): void {
  showPrompt({
    id: `blocked-${name.toLowerCase()}`,
    kind: 'notice',
    title: `${name} is blocked during class`,
    text: 'Your teacher has turned this app off for now. You can open it again once they allow it.',
  });
  const last = reported.get(name) ?? 0;
  if (Date.now() - last < REPORT_EVERY_MS) return;
  reported.set(name, Date.now());
  send({ type: 'app-closed', name: name.slice(0, 60) });
}
