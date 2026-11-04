// A small always-on-top window in the corner of the main screen that shows a
// stack of cards: teacher messages, polls, the raised-hand reminder, and later
// files, sign-in and warnings. It never takes keyboard focus on its own, so a
// student who is typing isn't interrupted mid-word.

import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import path from 'node:path';
import type { PromptCard } from './ipc';

type ActionHandler = (card: PromptCard, action: string, value: number | string | undefined) => void;

const WIDTH = 360;
const MARGIN = 16;

let cards: PromptCard[] = [];
let win: BrowserWindow | null = null;
let ready = false;
let lastHeight = 0;
let preload = '';
const handlers = new Map<PromptCard['kind'], ActionHandler>();

export function initPrompts(preloadPath: string): void {
  preload = preloadPath;
  const fromPrompts = (e: Electron.IpcMainEvent) => win !== null && e.sender === win.webContents;
  ipcMain.on('student:prompts-ready', (e) => {
    if (!fromPrompts(e)) return;
    ready = true;
    push();
  });
  ipcMain.on('student:prompt-action', (e, id: string, action: string, value?: number | string) => {
    if (!fromPrompts(e)) return;
    const card = cards.find((c) => c.id === id);
    const clean = typeof value === 'number' || typeof value === 'string' ? value : undefined;
    if (card) handlers.get(card.kind)?.(card, String(action), clean);
  });
  ipcMain.on('student:prompts-size', (e, height: number) => {
    if (fromPrompts(e) && Number.isFinite(height)) fit(height);
  });
}

/** Registers what happens when the student clicks a button on a kind of card. */
export function onPromptAction(kind: PromptCard['kind'], handler: ActionHandler): void {
  handlers.set(kind, handler);
}

/** Adds a card, or replaces the card with the same id. Newest cards go on top. */
export function showPrompt(card: PromptCard): void {
  cards = [card, ...cards.filter((c) => c.id !== card.id)];
  render();
}

export function removePrompt(id: string): void {
  removePrompts((c) => c.id === id);
}

export function removePrompts(match: (card: PromptCard) => boolean): void {
  const before = cards.length;
  cards = cards.filter((c) => !match(c));
  if (cards.length !== before) render();
}

export function findPrompt(id: string): PromptCard | undefined {
  return cards.find((c) => c.id === id);
}

function render(): void {
  push();
  if (!cards.length) {
    win?.hide();
    return;
  }
  if (!win) {
    createWindow();
    return; // Shown once the page reports its height.
  }
  // Coming back from hidden: the content height may not change, so no resize
  // report will arrive; reuse the last known height until one does.
  if (!win.isVisible() && lastHeight) fit(lastHeight);
}

function push(): void {
  if (win && ready) win.webContents.send('student:prompts', cards);
}

function createWindow(): void {
  ready = false;
  win = new BrowserWindow({
    width: WIDTH,
    height: 120,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: 'ClassMonitor',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f6f8',
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  void win.loadFile(path.join(__dirname, 'prompts.html'));
}

/** Sizes the window to its cards and pins it to the bottom-right of the main screen. */
function fit(contentHeight: number): void {
  lastHeight = contentHeight;
  if (!win || !cards.length) return;
  const area = screen.getPrimaryDisplay().workArea;
  const height = Math.max(60, Math.min(Math.ceil(contentHeight), area.height - MARGIN * 2));
  win.setBounds({
    x: area.x + area.width - WIDTH - MARGIN,
    y: area.y + area.height - height - MARGIN,
    width: WIDTH,
    height,
  });
  if (!win.isVisible()) win.showInactive();
}
