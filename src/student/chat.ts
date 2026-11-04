// Two-way chat with the teacher in a small window. It opens itself (without
// taking focus) when the teacher writes, or from the tray.

import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LIMITS } from '../shared/protocol';
import { handNote, lowerHand, raiseHand } from './hand';
import type { ChatLine, ChatState } from './ipc';
import { send, state } from './state';

let lines: ChatLine[] = [];
let win: BrowserWindow | null = null;
let preload = '';

export function initChat(preloadPath: string): void {
  preload = preloadPath;
  const fromChat = (e: Electron.IpcMainEvent) => win !== null && e.sender === win.webContents;
  ipcMain.on('student:chat-ready', (e) => fromChat(e) && push());
  ipcMain.on('student:chat-send', (e, text: string) => {
    const body = String(text ?? '').trim().slice(0, LIMITS.chat);
    if (!fromChat(e) || !body || !state.teacher) return;
    const line: ChatLine = { id: randomUUID(), from: 'me', text: body, at: Date.now() };
    send({ type: 'chat', id: line.id, text: body, at: line.at });
    lines.push(line);
    push();
  });
  ipcMain.on('student:hand', (e, raised: boolean) => {
    if (!fromChat(e)) return;
    if (raised) raiseHand();
    else lowerHand();
  });
}

/** A message from the teacher. */
export function receiveChat(id: string, text: string): void {
  lines.push({ id: String(id).slice(0, 64), from: 'teacher', text: String(text).slice(0, LIMITS.chat), at: Date.now() });
  if (win) {
    push();
    if (!win.isFocused()) win.flashFrame(true);
  } else {
    openChat(false);
  }
}

/** The teacher went away: start the next conversation fresh. */
export function resetChat(): void {
  lines = [];
  win?.close();
}

/** Re-sends the hand state after it changes elsewhere (tray, prompt card). */
export function refreshChat(): void {
  push();
}

export function openChat(focus = true): void {
  if (win) {
    win.show();
    if (focus) win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 360,
    height: 480,
    minWidth: 300,
    minHeight: 320,
    show: false,
    title: `Chat with ${state.teacher?.name ?? 'your teacher'}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f6f8',
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (focus) win?.show();
    else win?.showInactive();
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => (win = null));
  void win.loadFile(path.join(__dirname, 'chat.html'));
}

function push(): void {
  const chatState: ChatState = { teacher: state.teacher?.name ?? null, lines, handRaised: handNote() !== null };
  win?.webContents.send('student:chat', chatState);
}
