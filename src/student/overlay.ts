// Full-screen windows that cover every display while the class is locked or
// while the teacher is showing their screen. Broadcast takes precedence over
// lock; when it ends a still-locked student goes back to the lock screen.
// While either is up the keyboard and mouse are blocked (input-lock.ts) and
// the windows keep themselves above everything, the taskbar and Dock included.

import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { FrameMeta } from '../shared/protocol';
import { setInputLock } from './input-lock';
import type { OverlayState } from './ipc';

/** Development/testing: small ordinary windows instead of taking over the screen. */
const WINDOWED = process.env.CM_OVERLAY_WINDOWED === '1';
/** How often the windows put themselves back on top, over anything that popped up since. */
const RAISE_EVERY_MS = 1000;
/**
 * Windows: every overlay runs in real full-screen mode on its monitor, the way
 * games do. A window that merely has the screen's size isn't enough: Chromium
 * squeezes ordinary windows back into the work area (the screen minus the
 * taskbar) whenever Windows reports the work area changing, and the taskbar's
 * strip stays reserved even while the lock helper hides the taskbar, so it was
 * left uncovered. A full-screen window always fills the whole monitor.
 */
const GAME_FULL_SCREEN = !WINDOWED && process.platform === 'win32';

/** Lock windows refuse to close, except when the app itself is quitting (logout, shutdown). */
let quitting = false;
app.on('before-quit', () => (quitting = true));

export class Overlay {
  private windows: BrowserWindow[] = [];
  private primary: BrowserWindow | null = null;
  private raiseTimer: NodeJS.Timeout | null = null;
  private lockMessage: string | null = null;
  private broadcastSessionId: string | null = null;
  /** A classmate whose screen is being shown, or null for the teacher's. */
  private presenter: string | null = null;
  private teacher = 'your teacher';
  private rebuildTimer: NodeJS.Timeout | null = null;

  constructor(private readonly preload: string) {
    screen.on('display-added', () => this.rebuild());
    screen.on('display-removed', () => this.rebuild());
  }

  get locked(): boolean {
    return this.lockMessage !== null;
  }

  get broadcastSession(): string | null {
    return this.broadcastSessionId;
  }

  setTeacher(name: string): void {
    this.teacher = name;
  }

  lock(message: string): void {
    this.lockMessage = message;
    this.sync();
  }

  unlock(): void {
    this.lockMessage = null;
    this.sync();
  }

  startBroadcast(sessionId: string, presenter: string | null = null): void {
    this.broadcastSessionId = sessionId;
    this.presenter = presenter;
    this.sync();
  }

  stopBroadcast(sessionId?: string): void {
    if (sessionId && sessionId !== this.broadcastSessionId) return;
    this.broadcastSessionId = null;
    this.sync();
  }

  /** Teacher disconnected: never leave a student stuck behind a lock screen. */
  clear(): void {
    this.lockMessage = null;
    this.broadcastSessionId = null;
    this.sync();
  }

  owns(contents: Electron.WebContents): boolean {
    return this.windows.some((w) => !w.isDestroyed() && w.webContents === contents);
  }

  /** The teacher's screen, one encoded frame at a time, for the primary display's overlay to decode. */
  sendFrame(sessionId: string, meta: FrameMeta, data: Buffer): void {
    const win = this.primary;
    if (sessionId !== this.broadcastSessionId || !win || win.isDestroyed() || win.webContents.isLoading()) return;
    win.webContents.send('student:broadcast-frame', sessionId, meta, data);
  }

  pushState(contents: Electron.WebContents): void {
    const win = this.windows.find((w) => !w.isDestroyed() && w.webContents === contents);
    if (win) win.webContents.send('student:overlay-state', this.stateFor(win));
  }

  private stateFor(win: BrowserWindow): OverlayState {
    return {
      mode: this.broadcastSessionId ? 'broadcast' : 'lock',
      message: this.lockMessage ?? '',
      teacher: this.teacher,
      sessionId: this.broadcastSessionId,
      presenter: this.presenter ?? this.teacher,
      primary: win === this.primary,
    };
  }

  private sync(): void {
    const active = this.lockMessage !== null || this.broadcastSessionId !== null;
    setInputLock(active);
    if (!active) {
      this.destroyAll();
      return;
    }
    if (this.windows.length === 0) this.createAll();
    for (const win of this.windows) {
      if (!win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('student:overlay-state', this.stateFor(win));
    }
  }

  private rebuild(): void {
    if (this.windows.length === 0) return;
    this.destroyAll();
    this.sync();
  }

  private createAll(): void {
    const primaryId = screen.getPrimaryDisplay().id;
    for (const display of screen.getAllDisplays()) {
      const isPrimary = display.id === primaryId;
      const win = this.createWindow(display, isPrimary);
      this.windows.push(win);
      if (isPrimary) this.primary = win;
    }
    if (!WINDOWED) {
      this.raiseTimer = setInterval(() => {
        for (const win of this.windows) {
          if (win.isDestroyed()) continue;
          // Back to full screen if anything took it out (a display change, Explorer restarting).
          if (GAME_FULL_SCREEN && win.isVisible() && !win.isFullScreen()) win.setFullScreen(true);
          win.moveTop();
        }
      }, RAISE_EVERY_MS);
    }
  }

  private createWindow(display: Electron.Display, isPrimary: boolean): BrowserWindow {
    const { x, y, width, height } = display.bounds;
    const bounds = WINDOWED
      ? { x: x + Math.round(width / 2 - 320), y: y + Math.round(height / 2 - 200), width: 640, height: 400 }
      : { x, y, width, height };

    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      backgroundColor: '#0b0d12',
      hasShadow: false,
      enableLargerThanScreen: true,
      resizable: WINDOWED,
      movable: WINDOWED,
      minimizable: false,
      maximizable: false,
      // On a Mac, kiosk mode does the covering (and must not become a separate full-screen Space).
      fullscreenable: GAME_FULL_SCREEN,
      skipTaskbar: !WINDOWED,
      alwaysOnTop: !WINDOWED,
      // Kiosk on the primary display hides the taskbar/Dock and, on macOS, blocks
      // app switching and Force Quit while the lock is up. On Windows it is full screen.
      kiosk: !WINDOWED && isPrimary,
      title: 'ClassMonitor',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    if (!WINDOWED) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // Students can't close or switch away from the lock screen with the keyboard.
      win.on('blur', () => {
        if (isPrimary && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && takeFocus(win), 100);
      });
    }
    // Alt+F4 / Cmd+W do nothing; destroy() below bypasses this.
    win.on('close', (e) => {
      if (!quitting) e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    // A crashed page would leave a blank window (and no lock message): put fresh ones up.
    win.webContents.on('render-process-gone', (_e, details) => {
      if (quitting || details.reason === 'clean-exit') return;
      console.error(`[overlay] page ${details.reason}; rebuilding`);
      this.rebuildTimer ??= setTimeout(() => {
        this.rebuildTimer = null;
        this.rebuild();
      }, 500);
    });
    win.once('ready-to-show', () => {
      win.showInactive();
      if (GAME_FULL_SCREEN) win.setFullScreen(true);
      if (!isPrimary) return;
      if (WINDOWED) win.focus();
      else takeFocus(win);
    });
    void win.loadFile(path.join(__dirname, 'overlay.html'));
    return win;
  }

  private destroyAll(): void {
    if (this.raiseTimer) clearInterval(this.raiseTimer);
    this.raiseTimer = null;
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy();
    this.windows = [];
    this.primary = null;
  }
}

/**
 * Brings the lock window to the front. On macOS the agent has to become the
 * active app too: only then does kiosk mode hide the Dock and menu bar and
 * turn off Cmd+Tab and Force Quit, and only then do keys reach the overlay.
 */
function takeFocus(win: BrowserWindow): void {
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}
