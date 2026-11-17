// Closes every open app at the teacher's request, after a countdown the
// student can see so they can save their work. Apps are asked to quit the
// normal way (Cmd+Q on macOS, closing their windows on Windows), so an app
// with unsaved work can still ask the student first. Nothing is force-killed,
// and the OS shell and ClassMonitor itself are left alone (see app-match.ts).

import { execFile } from 'node:child_process';
import { appsToClose, displayName } from '../shared/app-match';
import { LIMITS } from '../shared/protocol';
import { removePrompt, showPrompt } from './prompts';
import { send } from './state';

/** Testing: log which apps would close instead of closing them. */
const DRY_RUN = process.env.CM_CLOSE_APPS_DRY_RUN === '1';
const PROMPT_ID = 'close-apps';

type OpenApp = { pid: number; path: string };

/** macOS: apps with a Dock icon (the "regular" ones), as JSON. No permission needed. */
const MAC_LIST = `
ObjC.import('AppKit');
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const out = [];
for (let i = 0; i < apps.count; i++) {
  const a = apps.objectAtIndex(i);
  if (a.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue;
  const url = a.bundleURL.isNil() ? a.executableURL : a.bundleURL;
  out.push({ pid: a.processIdentifier, path: url.isNil() ? '' : ObjC.unwrap(url.path) });
}
JSON.stringify(out);`;

/** macOS: asks the apps whose pids are the arguments to quit, as Cmd+Q would. */
const MAC_QUIT = `
function run(argv) {
  ObjC.import('AppKit');
  for (const pid of argv) {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid));
    if (!app.isNil()) app.terminate;
  }
}`;

/** Windows: this user's programs with a visible window, as JSON. */
const WIN_LIST = `
$session = (Get-Process -Id $PID).SessionId
$apps = Get-Process | Where-Object { $_.SessionId -eq $session -and $_.MainWindowHandle -ne 0 } |
  ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $(if ($_.Path) { $_.Path } else { "$($_.ProcessName).exe" }) } }
ConvertTo-Json -InputObject @($apps) -Compress`;

let timer: NodeJS.Timeout | null = null;

export function scheduleCloseApps(delaySeconds: number): void {
  const delay = Math.max(0, Math.min(LIMITS.powerDelayMax, Number(delaySeconds) || 0));
  showPrompt({ id: PROMPT_ID, kind: 'power', action: 'close-apps', deadline: Date.now() + delay * 1000 });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void closeAll(), delay * 1000);
}

/** Resolves to the command's output, or null if it failed. */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function openApps(): Promise<OpenApp[] | null> {
  const out =
    process.platform === 'darwin'
      ? await run('osascript', ['-l', 'JavaScript', '-e', MAC_LIST])
      : await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIST]);
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out.trim() || '[]') as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((a): a is OpenApp => typeof a?.pid === 'number' && typeof a?.path === 'string')
      .map((a) => ({ pid: a.pid, path: a.path }));
  } catch {
    return null;
  }
}

async function closeAll(): Promise<void> {
  timer = null;
  removePrompt(PROMPT_ID);
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    send({ type: 'error', message: `Closing apps isn't supported on ${process.platform}.` });
    return;
  }
  const open = await openApps();
  if (!open) {
    send({ type: 'error', message: "Couldn't list the apps open on this computer." });
    return;
  }
  const apps = appsToClose(open, [process.pid, process.ppid]);
  if (DRY_RUN) {
    console.log(`[close-apps] ${apps.map((a) => displayName(a.path)).join(', ') || 'nothing open'} (dry run)`);
    return;
  }
  if (!apps.length) return;
  const pids = apps.map((a) => String(a.pid));
  if (process.platform === 'darwin') {
    if ((await run('osascript', ['-l', 'JavaScript', '-e', MAC_QUIT, ...pids])) === null) {
      send({ type: 'error', message: "Couldn't ask the open apps to quit." });
    }
  } else {
    // Without /F, taskkill asks each window to close, like clicking its ✕. It
    // reports failure when any app was already gone, so the result is ignored.
    await run('taskkill', pids.flatMap((pid) => ['/PID', pid]));
  }
}
