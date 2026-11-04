// Log off, restart or shut down at the teacher's request, after a countdown
// the student can see so they can save their work.

import { execFile } from 'node:child_process';
import { LIMITS, type PowerAction } from '../shared/protocol';
import { removePrompt, showPrompt } from './prompts';
import { send } from './state';

/** Testing: log the action instead of shutting the computer down. */
const DRY_RUN = process.env.CM_POWER_DRY_RUN === '1';

let timer: NodeJS.Timeout | null = null;

const COMMANDS: Record<PowerAction, Record<'darwin' | 'win32', [string, string[]]>> = {
  // macOS asks running apps to quit (so they can offer to save); needs the
  // Automation permission for System Events / loginwindow.
  logoff: { darwin: ['osascript', ['-e', 'tell application "loginwindow" to «event aevtrlgo»']], win32: ['shutdown', ['/l']] },
  restart: { darwin: ['osascript', ['-e', 'tell application "System Events" to restart']], win32: ['shutdown', ['/r', '/t', '0']] },
  shutdown: { darwin: ['osascript', ['-e', 'tell application "System Events" to shut down']], win32: ['shutdown', ['/s', '/t', '0']] },
};

export function schedulePower(action: PowerAction, delaySeconds: number): void {
  if (!(action in COMMANDS)) return;
  const delay = Math.max(0, Math.min(LIMITS.powerDelayMax, Number(delaySeconds) || 0));
  showPrompt({ id: 'power', kind: 'power', action, deadline: Date.now() + delay * 1000 });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => run(action), delay * 1000);
}

function run(action: PowerAction): void {
  timer = null;
  removePrompt('power');
  if (DRY_RUN) {
    console.log(`[power] ${action} (dry run)`);
    return;
  }
  const command = COMMANDS[action][process.platform as 'darwin' | 'win32'];
  if (!command) {
    send({ type: 'error', message: `Power controls aren't supported on ${process.platform}.` });
    return;
  }
  execFile(command[0], command[1], { windowsHide: true }, (err) => {
    if (err) send({ type: 'error', message: `Couldn't ${action === 'logoff' ? 'log off' : action}: ${err.message.slice(0, 160)}` });
  });
}
