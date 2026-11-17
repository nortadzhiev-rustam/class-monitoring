// Website rules without the browser extension. While the teacher's rules are
// on, the student app reads the address each browser window shows, every
// second, and sends a window that opened a blocked site to the block page
// (block-page.ts). It works from outside the browser, so nothing has to be
// installed in it, but it only sees the tab on screen in each window, catches a
// site after it starts opening, and can't stop sites embedded in other pages.
// The extension, where installed, blocks before anything loads; both can run.
//
//   Windows: native/windows/browser-helper.ps1 reads the address bars of
//            Chrome, Edge, Firefox, Brave, Vivaldi and Opera (UI Automation).
//   macOS:   AppleScript asks Chrome, Edge, Brave, Vivaldi, Chromium and
//            Safari for their tabs (the Automation permission, per browser).
//   Tests:   CM_BROWSERS_FILE names a JSON file that plays the browsers.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { programNames } from '../shared/app-match';
import { resourcePath } from '../shared/electron-setup';
import { addressUrl, blocksHost, type WebRules } from '../shared/web-rules';
import { runningProcesses } from './app-blocker';
import { blockPageUrl, isBlockPage, startBlockPage } from './block-page';

const SCAN_MS = 1000;
/** Text left unchanged this long in an address bar the student is typing in counts as the page. */
const SETTLE_MS = 3000;
/** Time for a redirected window to load the block page before it's judged again. */
const REDIRECT_PAUSE_MS = 3000;
const SCAN_TIMEOUT_MS = 15_000;

export interface BrowserTab {
  /** The window, as the source names it (a window handle, a browser and window id). */
  window: string;
  /** What the address bar shows; null if it couldn't be read. */
  address: string | null;
  title: string | null;
  /** In the window the student is using. */
  front: boolean;
  /** The student's cursor is in the address bar (Windows): the text may be half-typed. */
  editing: boolean;
}

interface Scan {
  tabs: BrowserTab[];
  /** False when a browser is open that couldn't be read (no permission, no address bar found). */
  readable: boolean;
}

interface BrowserSource {
  /** Every browser window's current tab; null when this computer can't be watched right now. */
  scan(): Promise<Scan | null>;
  /** Sends that window's current tab to `url`. */
  open(window: string, url: string): void;
  stop(): void;
}

export interface WatchStatus {
  /** Every open browser can be read (or none is open), so the rules apply there. */
  watching: boolean;
  url: string | null;
  title: string | null;
}

/** A scan's answer from a helper or file, checked before use. */
function tabsFrom(raw: unknown): BrowserTab[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object' && typeof (t as { window?: unknown }).window === 'string')
    .map((t) => ({
      window: String(t.window).slice(0, 200),
      address: typeof t.address === 'string' ? t.address.slice(0, 4000) : null,
      title: typeof t.title === 'string' ? t.title.slice(0, 200) : null,
      front: t.front === true,
      editing: t.editing === true,
    }));
}

// ---------------------------------------------------------------- sources

/** Testing: {"readable": true, "tabs": [...]} in a file; opening a page rewrites that tab's address. */
class FileSource implements BrowserSource {
  constructor(private file: string) {}

  async scan(): Promise<Scan | null> {
    try {
      const data = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      return { tabs: tabsFrom(data.tabs), readable: data.readable !== false };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { tabs: [], readable: true } : null;
    }
  }

  open(window: string, url: string): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const tab of data.tabs ?? []) if (tab.window === window) tab.address = url;
      fs.writeFileSync(this.file, JSON.stringify(data));
    } catch (err) {
      console.warn('[web] test browsers file:', (err as Error).message);
    }
  }

  stop(): void {}
}

/** Windows: a PowerShell helper that reads address bars through UI Automation (see the script for its protocol). */
class WindowsSource implements BrowserSource {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private waiting: ((scan: Scan | null) => void) | null = null;
  private restarts = 0;

  private start(): ChildProcessWithoutNullStreams | null {
    if (this.helper) return this.helper;
    // A helper that keeps dying (PowerShell blocked, script missing) isn't retried forever.
    if (this.restarts >= 5) return null;
    this.restarts++;
    const script = resourcePath('native', 'windows', 'browser-helper.ps1');
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: 'pipe',
      windowsHide: true,
    });
    let lines = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => {
      lines += chunk;
      for (let nl = lines.indexOf('\n'); nl >= 0; nl = lines.indexOf('\n')) {
        const line = lines.slice(0, nl).replace(/^\uFEFF/, '').trim();
        lines = lines.slice(nl + 1);
        if (line) this.answer(line);
      }
    });
    helper.stderr.on('data', (d) => console.warn('[browser-helper]', String(d).trim()));
    helper.on('error', (err) => console.warn('[browser-helper] failed:', err.message));
    helper.on('exit', () => {
      if (this.helper === helper) this.helper = null;
      this.finish(null);
    });
    helper.stdin.on('error', () => {});
    this.helper = helper;
    return helper;
  }

  private answer(line: string): void {
    let message: { tabs?: unknown; readable?: unknown; error?: unknown; opened?: unknown; how?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ('tabs' in message) {
      if (typeof message.error === 'string') console.warn('[browser-helper]', message.error);
      this.restarts = 0;
      this.finish({ tabs: tabsFrom(message.tabs), readable: message.readable === true });
    } else if (message.how === 'failed') {
      console.warn('[browser-helper] could not change the address of window', message.opened);
    }
  }

  private finish(scan: Scan | null): void {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.(scan);
  }

  scan(): Promise<Scan | null> {
    const helper = this.start();
    if (!helper) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // UI Automation stuck on a busy window: start a fresh helper next time.
        helper.kill();
        this.finish(null);
      }, SCAN_TIMEOUT_MS);
      this.waiting = (scan) => {
        clearTimeout(timer);
        resolve(scan);
      };
      helper.stdin.write('scan\n');
    });
  }

  open(window: string, url: string): void {
    if (/^\d+$/.test(window) && /^\S+$/.test(url)) this.helper?.stdin.write(`open ${window} ${url}\n`);
  }

  stop(): void {
    this.helper?.stdin.end();
    this.helper = null;
    this.finish(null);
  }
}

interface MacBrowser {
  /** Bundle identifier. */
  id: string;
  /** Its name in the process list (see programNames). */
  process: string;
  tab: 'active tab' | 'current tab';
  title: 'title' | 'name';
}

/** Browsers with an AppleScript dictionary that has tab URLs. Firefox has none. */
const MAC_BROWSERS: MacBrowser[] = [
  { id: 'com.google.Chrome', process: 'google chrome', tab: 'active tab', title: 'title' },
  { id: 'com.microsoft.edgemac', process: 'microsoft edge', tab: 'active tab', title: 'title' },
  { id: 'com.brave.Browser', process: 'brave browser', tab: 'active tab', title: 'title' },
  { id: 'com.vivaldi.Vivaldi', process: 'vivaldi', tab: 'active tab', title: 'title' },
  { id: 'org.chromium.Chromium', process: 'chromium', tab: 'active tab', title: 'title' },
  { id: 'com.apple.Safari', process: 'safari', tab: 'current tab', title: 'name' },
];
/** "Not authorized to send Apple events": the student (or a profile) said no to the Automation permission. */
const NOT_ALLOWED = '-1743';
const FIELD = '\u001f';
const RECORD = '\u001e';

/**
 * One AppleScript run that lists every window's tab of the running browsers:
 * bundle id, window id, front, URL, title. Only running browsers are asked,
 * since naming one that isn't installed would make AppleScript look for it.
 */
export function macScanScript(browsers: Array<Pick<MacBrowser, 'id' | 'tab' | 'title'>>): string {
  const lines = ['set fs to character id 31', 'set rs to character id 30', 'set out to ""'];
  for (const b of browsers) {
    lines.push(
      `if application id "${b.id}" is running then`,
      '  try',
      `    tell application id "${b.id}"`,
      '      set isFront to frontmost',
      '      set n to 0',
      '      repeat with w in windows',
      '        set n to n + 1',
      '        try',
      `          set t to ${b.tab} of w`,
      '          set u to URL of t',
      '          if u is missing value then set u to ""',
      `          set h to ${b.title} of t`,
      '          if h is missing value then set h to ""',
      `          set out to out & "${b.id}" & fs & (id of w) & fs & (isFront and n is 1) & fs & u & fs & h & rs`,
      '        end try',
      '      end repeat',
      '    end tell',
      '  on error e number num',
      `    set out to out & "${b.id}" & fs & "error" & fs & num & rs`,
      '  end try',
      'end if',
    );
  }
  lines.push('return out');
  return lines.join('\n');
}

/** Reads macScanScript's output. */
export function parseMacScan(out: string): Scan {
  const tabs: BrowserTab[] = [];
  let readable = true;
  for (const record of out.replace(/\n$/, '').split(RECORD)) {
    const [id, window, front, url, ...title] = record.split(FIELD);
    if (!id || window === undefined) continue;
    if (window === 'error') {
      // Not running any more (-600) is fine; anything else means this browser can't be watched.
      if (front !== '-600') readable = false;
      if (front === NOT_ALLOWED) console.warn(`[web] not allowed to read ${id}: grant ClassMonitor Student Automation access to it`);
      continue;
    }
    tabs.push({ window: `${id}:${window}`, address: url ?? '', title: title.join(FIELD) || null, front: front === 'true', editing: false });
  }
  return { tabs, readable };
}

/** macOS: asks the running browsers through AppleScript. */
class MacSource implements BrowserSource {
  async scan(): Promise<Scan | null> {
    const names = new Set((await runningProcesses()).flatMap((p) => programNames(p.path)));
    const running = MAC_BROWSERS.filter((b) => names.has(b.process));
    if (!running.length) return { tabs: [], readable: true };
    return new Promise((resolve) => {
      execFile('osascript', ['-e', macScanScript(running)], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          console.warn('[web] reading the browsers failed:', err.message.split('\n')[0]);
          resolve(null);
        } else resolve(parseMacScan(String(stdout)));
      });
    });
  }

  open(window: string, url: string): void {
    const at = window.lastIndexOf(':');
    const browser = MAC_BROWSERS.find((b) => b.id === window.slice(0, at));
    const id = window.slice(at + 1);
    if (!browser || !/^\d+$/.test(id)) return;
    const script = `tell application id "${browser.id}" to set URL of ${browser.tab} of window id ${id} to "${url.replace(/["\\]/g, '')}"`;
    execFile('osascript', ['-e', script], { timeout: SCAN_TIMEOUT_MS }, (err) => {
      if (err) console.warn('[web] could not change the address:', err.message.split('\n')[0]);
    });
  }

  stop(): void {}
}

function createSource(): BrowserSource | null {
  if (process.env.CM_BROWSERS_FILE) return new FileSource(process.env.CM_BROWSERS_FILE);
  if (process.platform === 'win32') return new WindowsSource();
  if (process.platform === 'darwin') return new MacSource();
  return null;
}

// ---------------------------------------------------------------- watching

let rules: WebRules | null = null;
let source: BrowserSource | null = null;
let timer: NodeJS.Timeout | null = null;
let scanning = false;
let origin: string | null = null;
let report: (status: WatchStatus) => void = () => {};
/** Address bars the student is typing in: their text and since when it's been unchanged. */
const typing = new Map<string, { text: string; since: number }>();
const redirected = new Map<string, number>();

/** Starts, updates or (null) stops watching; `onStatus` hears whether it works and the student's current site. */
export function watchBrowsers(next: WebRules | null, onStatus: (status: WatchStatus) => void): void {
  rules = next;
  report = onStatus;
  if (rules && !timer) {
    source = createSource();
    if (!source) {
      report({ watching: false, url: null, title: null });
      return;
    }
    // Until the first look says otherwise, so the console doesn't flash "Web filter missing".
    report({ watching: true, url: null, title: null });
    timer = setInterval(() => void scan(), SCAN_MS);
    void scan();
  } else if (!rules && timer) {
    clearInterval(timer);
    timer = null;
    source?.stop();
    source = null;
    typing.clear();
    redirected.clear();
    report({ watching: false, url: null, title: null });
  }
}

async function scan(): Promise<void> {
  if (scanning || !source) return;
  scanning = true;
  const from = source;
  try {
    origin ??= await startBlockPage(() => rules).catch((err) => {
      console.warn('[web] block page unavailable:', (err as Error).message);
      return null;
    });
    const result = await from.scan();
    if (from !== source || !rules) return; // Stopped while looking.
    if (!result) {
      report({ watching: false, url: null, title: null });
      return;
    }
    act(result.tabs, Date.now());
    const shown = siteShown(result.tabs);
    report({ watching: result.readable, url: shown?.url ?? null, title: shown?.title ?? null });
  } catch (err) {
    console.warn('[web] watching the browsers failed:', (err as Error).message);
  } finally {
    scanning = false;
  }
}

/** Sends every tab showing a blocked site to the block page. */
function act(tabs: BrowserTab[], now: number): void {
  const windows = new Set(tabs.map((t) => t.window));
  for (const map of [typing, redirected]) for (const key of map.keys()) if (!windows.has(key)) map.delete(key);
  for (const tab of tabs) {
    const url = tab.address === null ? null : addressUrl(tab.address);
    if (!url || (origin && isBlockPage(origin, url))) {
      typing.delete(tab.window);
      continue;
    }
    if (tab.editing) {
      // Half-typed text ("wikipedia.o") isn't a page; judge it once it stops changing.
      const seen = typing.get(tab.window);
      if (!seen || seen.text !== tab.address) {
        typing.set(tab.window, { text: tab.address!, since: now });
        continue;
      }
      if (now - seen.since < SETTLE_MS) continue;
    } else typing.delete(tab.window);
    if (!origin || !blocksHost(rules, url.hostname)) continue;
    if (now - (redirected.get(tab.window) ?? 0) < REDIRECT_PAUSE_MS) continue;
    redirected.set(tab.window, now);
    source?.open(tab.window, blockPageUrl(origin, url.hostname));
  }
}

/** The site in the window the student is using, for the teacher's card (not the block page, not half-typed text). */
function siteShown(tabs: BrowserTab[]): { url: string; title: string | null } | null {
  const tab = tabs.find((t) => t.front) ?? tabs[0];
  if (!tab || tab.editing || tab.address === null) return null;
  const url = addressUrl(tab.address);
  if (!url || (origin && isBlockPage(origin, url))) return null;
  return { url: url.href, title: tab.title };
}
