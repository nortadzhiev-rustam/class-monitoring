// Injects the teacher's mouse and keyboard input through a small per-OS helper
// process (see native/), fed one command per line on stdin:
//   m <x> <y>                     move pointer to desktop coordinates (macOS points,
//                                 Windows physical pixels; negative left of/above the main screen)
//   b <button> <down> <x> <y> <n> button 0/1/2, down 1/0, click count n; x y = "- -" for where the pointer is
//   w <dx> <dy>                   scroll by pixels (DOM wheel deltas)
//   k <code> <down> <extended>    native key code (macOS kVK / Windows VK)
//   r                             release every held key and button

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { resourcePath } from '../shared/electron-setup';
import { nativeKey } from '../shared/keymap';
import type { InputEvent, Platform } from '../shared/protocol';

/** Testing: the helper logs events to stdout instead of moving the real mouse. */
export const INPUT_DRY_RUN = process.env.CM_INPUT_DRY_RUN === '1';

function helperCommand(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    const binary = resourcePath('native-bin', 'darwin', 'input-helper');
    return fs.existsSync(binary) ? { command: binary, args: INPUT_DRY_RUN ? ['--dry-run'] : [] } : null;
  }
  if (process.platform === 'win32') {
    const script = resourcePath('native', 'windows', 'input-helper.ps1');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(INPUT_DRY_RUN ? ['-DryRun'] : [])],
    };
  }
  return null;
}

const num = (n: number, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : '0');

/** Turns 0..1 coordinates on the viewed monitor into desktop coordinates. */
export type ToDesktop = (nx: number, ny: number) => { x: number; y: number };

export class InputInjector {
  private helper: ChildProcessWithoutNullStreams | null = null;

  /** Throws if this platform has no helper (e.g. the macOS binary wasn't built). */
  start(): void {
    if (this.helper) return;
    const cmd = helperCommand();
    if (!cmd) throw new Error('Remote control helper is missing on this computer.');
    const helper = spawn(cmd.command, cmd.args, { stdio: 'pipe', windowsHide: true });
    helper.stderr.on('data', (d) => console.warn('[input-helper]', String(d).trim()));
    if (INPUT_DRY_RUN) helper.stdout.on('data', (d) => console.log(String(d).trim().replace(/^/gm, '[input-helper] ')));
    helper.on('error', (err) => console.warn('[input-helper] failed:', err.message));
    helper.on('exit', () => {
      if (this.helper === helper) this.helper = null;
    });
    helper.stdin.on('error', () => {});
    this.helper = helper;
  }

  stop(): void {
    this.write('r');
    this.helper?.stdin.end();
    this.helper = null;
  }

  inject(events: InputEvent[], teacherPlatform: Platform, toDesktop: ToDesktop): void {
    const at = (x: number, y: number) => {
      const p = toDesktop(x, y);
      return `${num(p.x, 1)} ${num(p.y, 1)}`;
    };
    for (const e of events) {
      switch (e.t) {
        case 'move':
          this.write(`m ${at(e.x, e.y)}`);
          break;
        case 'button': {
          // The teacher sends x/y < 0 to mean "wherever the pointer is" (releasing held buttons).
          const where = e.x < 0 || e.y < 0 ? '- -' : at(e.x, e.y);
          this.write(`b ${e.button === 2 ? 2 : e.button === 1 ? 1 : 0} ${e.down ? 1 : 0} ${where} ${num(Math.min(3, e.clicks))}`);
          break;
        }
        case 'wheel':
          this.write(`w ${num(e.dx)} ${num(e.dy)}`);
          break;
        case 'key': {
          const key = nativeKey(e.code, process.platform, teacherPlatform);
          if (!key) break;
          const code = process.platform === 'darwin' ? key.mac : key.win;
          this.write(`k ${code} ${e.down ? 1 : 0} ${key.ext ? 1 : 0}`);
          break;
        }
      }
    }
  }

  private write(line: string): void {
    if (this.helper?.stdin.writable) this.helper.stdin.write(`${line}\n`);
  }
}
