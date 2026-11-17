// The student's toolbar: a slim bar at the top of the main screen while the
// teacher is connected. It says who is connected and whether they are watching,
// and holds the student's tools (raise hand, chat, hand in work). It tucks away
// to a small tab and slides out on hover, and it never takes keyboard focus, so
// it stays out of the way of whatever the student is doing.
//
// The window is wider than the bar and transparent; outside the bar, clicks go
// through to the apps underneath (the page says when the pointer is on the bar).

import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { TOOLBAR_ACTIONS, type ToolbarAction, type ToolbarState } from './ipc';

/** Room for the widest bar and its shadow. */
const WIDTH = 820;
const HEIGHT = 64;

let win: BrowserWindow | null = null;
let ready = false;
let current: ToolbarState | null = null;
let preload = '';
let act: (action: ToolbarAction) => void = () => {};

export function initToolbar(preloadPath: string, onAction: (action: ToolbarAction) => void): void {
  preload = preloadPath;
  act = onAction;
  const fromToolbar = (e: Electron.IpcMainEvent) => win !== null && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on('student:toolbar-ready', (e) => {
    if (!fromToolbar(e)) return;
    ready = true;
    updateToolbar(current);
  });
  ipcMain.on('student:toolbar-action', (e, action: ToolbarAction) => {
    if (fromToolbar(e) && TOOLBAR_ACTIONS.includes(action)) act(action);
  });
  ipcMain.on('student:toolbar-pointer', (e, over: boolean) => {
    if (fromToolbar(e)) win!.setIgnoreMouseEvents(over !== true, { forward: true });
  });
  screen.on('display-added', place);
  screen.on('display-removed', place);
  screen.on('display-metrics-changed', place);
}

/** Shows the toolbar with this state, or hides it (null: no teacher, or the screen is locked or showing the teacher's). */
export function updateToolbar(next: ToolbarState | null): void {
  current = next;
  if (!next) {
    if (win?.isVisible()) win.hide();
    return;
  }
  if (!win || win.isDestroyed()) {
    create();
    return; // Shown when the page has loaded.
  }
  push();
  if (ready && !win.isVisible()) {
    place();
    win.showInactive();
  }
}

function push(): void {
  if (win && ready && current) win.webContents.send('student:toolbar', current);
}

function create(): void {
  ready = false;
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Clicking a button must not pull focus from the student's work.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'ClassMonitor',
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  win = w;
  // Above ordinary windows, below the lock screen ('screen-saver').
  w.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setIgnoreMouseEvents(true, { forward: true });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('render-process-gone', () => {
    if (win === w) win = null;
    ready = false;
    if (!w.isDestroyed()) w.destroy();
    setTimeout(() => updateToolbar(current), 500);
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  void w.loadFile(path.join(__dirname, 'toolbar.html'));
}

/** Top centre of the main screen, below the menu bar on a Mac. */
function place(): void {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(WIDTH, area.width);
  win.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height: HEIGHT });
}
