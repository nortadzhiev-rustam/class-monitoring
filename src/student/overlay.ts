// Full-screen windows that cover every display while the class is locked or
// while the teacher is showing their screen. Broadcast takes precedence over
// lock; when it ends a still-locked student goes back to the lock screen.

import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { OverlayState } from './ipc';

/** Development/testing: small ordinary windows instead of taking over the screen. */
const WINDOWED = process.env.CM_OVERLAY_WINDOWED === '1';

/** Lock windows refuse to close, except when the app itself is quitting (logout, shutdown). */
let quitting = false;
app.on('before-quit', () => (quitting = true));

export class Overlay {
  private windows: BrowserWindow[] = [];
  private primary: BrowserWindow | null = null;
  private lockMessage: string | null = null;
  private broadcastSessionId: string | null = null;
  private teacher = 'your teacher';

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

  startBroadcast(sessionId: string): void {
    this.broadcastSessionId = sessionId;
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

  /** Signals for the broadcast session go to the primary display's overlay. */
  sendSignal(sessionId: string, signal: unknown): void {
    if (sessionId === this.broadcastSessionId && this.primary && !this.primary.isDestroyed()) {
      this.primary.webContents.send('student:signal', sessionId, signal);
    }
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
      primary: win === this.primary,
    };
  }

  private sync(): void {
    const active = this.lockMessage !== null || this.broadcastSessionId !== null;
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
      fullscreenable: false,
      skipTaskbar: !WINDOWED,
      alwaysOnTop: !WINDOWED,
      // Kiosk on the primary display hides the taskbar/Dock and, on macOS, blocks
      // app switching and Force Quit while the lock is up.
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
        if (isPrimary && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.focus(), 100);
      });
    }
    // Alt+F4 / Cmd+W do nothing; destroy() below bypasses this.
    win.on('close', (e) => {
      if (!quitting) e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      win.showInactive();
      if (isPrimary) win.focus();
    });
    void win.loadFile(path.join(__dirname, 'overlay.html'));
    return win;
  }

  private destroyAll(): void {
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy();
    this.windows = [];
    this.primary = null;
  }
}
