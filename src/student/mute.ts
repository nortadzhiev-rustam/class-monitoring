// Turns the computer's sound off while the teacher has it muted, through a
// helper (see native/): Core Audio on macOS, the Windows audio endpoint API on
// Windows. The helper keeps the sound off (headphones plugged in, the student
// pressing the volume keys) and puts each speaker back the way it was when its
// stdin closes, so the sound comes back by itself if ClassMonitor stops muting,
// quits or crashes.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { resourcePath } from '../shared/electron-setup';

/** Testing: the helper only logs "muted" / "unmuted" and leaves this computer's sound alone. */
const DRY_RUN = process.env.CM_MUTE_DRY_RUN === '1';
const MAX_RESTARTS = 5;

let helper: ChildProcessWithoutNullStreams | null = null;
let wanted = false;
let restarts = 0;

function helperCommand(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    const binary = resourcePath('native-bin', 'darwin', 'input-helper');
    return fs.existsSync(binary) ? { command: binary, args: ['--mute', ...(DRY_RUN ? ['--dry-run'] : [])] } : null;
  }
  if (process.platform === 'win32') {
    const script = resourcePath('native', 'windows', 'audio-helper.ps1');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(DRY_RUN ? ['-DryRun'] : [])],
    };
  }
  return null;
}

export const isMuted = () => wanted;

/** Mutes or unmutes to match the teacher's policy; safe to call repeatedly. */
export function setMuted(on: boolean): void {
  if (on === wanted) return;
  wanted = on;
  restarts = 0;
  if (on) start();
  else stop();
}

function start(): void {
  if (helper) return;
  const cmd = helperCommand();
  if (!cmd) {
    console.warn('[mute] no audio helper on this computer; the sound stays on');
    return;
  }
  const child = spawn(cmd.command, cmd.args, { stdio: 'pipe', windowsHide: true });
  helper = child;
  child.stdout.on('data', (d) => console.log(String(d).trim().replace(/^/gm, '[mute] ')));
  child.stderr.on('data', (d) => console.warn('[mute]', String(d).trim()));
  child.stdin.on('error', () => {});
  child.on('error', (err) => console.warn('[mute] failed:', err.message));
  child.on('exit', () => {
    if (helper !== child) return; // Stopped on purpose.
    helper = null;
    // Gone while the sound should still be off (killed or crashed): start it again, a few times at most.
    if (wanted && restarts++ < MAX_RESTARTS) setTimeout(() => wanted && start(), 1000);
  });
}

function stop(): void {
  const child = helper;
  helper = null;
  child?.stdin.end(); // The helper puts the sound back and exits when its stdin closes.
}
