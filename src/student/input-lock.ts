// Blocks the student's keyboard and mouse while the lock screen or the
// teacher's screen is up, through a helper (see native/): low-level hooks plus
// a hidden taskbar on Windows, an event tap on macOS (needs the Accessibility
// permission, like remote control). Remote-control input from ClassMonitor's
// own input helper is tagged and still gets through.
//
// The helper runs until its stdin closes, so it lets go by itself if
// ClassMonitor stops the lock, quits or crashes.

import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { resourcePath } from '../shared/electron-setup';

/** Testing: the helper only logs "locked" / "unlocked". */
const DRY_RUN = process.env.CM_INPUT_DRY_RUN === '1';
/**
 * Only installed apps block for real. Development builds (and the small
 * CM_OVERLAY_WINDOWED windows) never do, so a developer who locks themselves
 * can still reach the teacher console and the Cmd/Ctrl+Alt+Shift+U escape.
 * CM_INPUT_LOCK=1 turns it on in development anyway.
 */
const REAL = (app.isPackaged || process.env.CM_INPUT_LOCK === '1') && process.env.CM_OVERLAY_WINDOWED !== '1';
const ENABLED = DRY_RUN || REAL;
/** The helper's exit code when the OS refuses (no Accessibility permission on macOS): don't retry. */
const REFUSED = 3;
const MAX_RESTARTS = 5;

let helper: ChildProcessWithoutNullStreams | null = null;
let wanted = false;
let restarts = 0;

function helperCommand(extra: string[]): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    const binary = resourcePath('native-bin', 'darwin', 'input-helper');
    return fs.existsSync(binary) ? { command: binary, args: ['--lock', ...(DRY_RUN ? ['--dry-run'] : [])] } : null;
  }
  if (process.platform === 'win32') {
    const script = resourcePath('native', 'windows', 'lock-helper.ps1');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra, ...(DRY_RUN ? ['-DryRun'] : [])],
    };
  }
  return null;
}

/** Called whenever the overlay comes up or goes away. */
export function setInputLock(on: boolean): void {
  if (!ENABLED || on === wanted) return;
  wanted = on;
  restarts = 0;
  if (on) start();
  else stop();
}

/** Windows: shows the taskbar again if a lock helper was killed while it was hidden. */
export function restoreAfterCrash(): void {
  if (process.platform !== 'win32' || !REAL || DRY_RUN) return;
  const cmd = helperCommand(['-Restore']);
  if (cmd) spawn(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true }).on('error', () => {});
}

function start(): void {
  if (helper) return;
  const cmd = helperCommand([]);
  if (!cmd) {
    console.warn('[input-lock] no lock helper on this computer; the keyboard and mouse stay usable');
    return;
  }
  const child = spawn(cmd.command, cmd.args, { stdio: 'pipe', windowsHide: true });
  helper = child;
  child.stdout.on('data', (d) => console.log(String(d).trim().replace(/^/gm, '[input-lock] ')));
  child.stderr.on('data', (d) => console.warn('[input-lock]', String(d).trim()));
  child.stdin.on('error', () => {});
  child.on('error', (err) => console.warn('[input-lock] failed:', err.message));
  child.on('exit', (code) => {
    if (helper !== child) return; // Stopped on purpose.
    helper = null;
    // Gone while the lock is still up (killed or crashed): start it again, a few times at most.
    if (wanted && code !== REFUSED && restarts++ < MAX_RESTARTS) setTimeout(() => wanted && start(), 1000);
  });
}

function stop(): void {
  const child = helper;
  helper = null;
  child?.stdin.end(); // The helper lets go and exits when its stdin closes.
}
