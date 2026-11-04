// Remote view and remote control sessions. The hidden agent window streams the
// screen; the input helper injects the teacher's mouse and keyboard.

import { BrowserWindow, systemPreferences } from 'electron';
import path from 'node:path';
import type { InputEvent, Platform, RtcSignal } from '../shared/protocol';
import { INPUT_DRY_RUN, InputInjector } from './input';
import { changed, send } from './state';

/** Open remote-view sessions; `control` holds the one allowed to send input. */
const viewSessions = new Set<string>();
let control: { sessionId: string; teacherPlatform: Platform } | null = null;
const injector = new InputInjector();
let agent: BrowserWindow | null = null;

export const viewing = () => viewSessions.size > 0;
export const controlled = () => control !== null;
export const owns = (sessionId: string) => viewSessions.has(sessionId);
export const isAgent = (contents: Electron.WebContents) => contents === agent?.webContents;

export function createAgentWindow(preload: string): void {
  agent = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  agent.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  agent.webContents.on('will-navigate', (e) => e.preventDefault());
  void agent.loadFile(path.join(__dirname, 'agent.html'));
}

export function startView(sessionId: string): void {
  viewSessions.add(sessionId);
  agent?.webContents.send('student:view', { type: 'start', sessionId });
  changed();
}

export function endView(sessionId: string): void {
  if (!viewSessions.delete(sessionId)) return;
  agent?.webContents.send('student:view', { type: 'stop', sessionId });
  if (control?.sessionId === sessionId) setControl(sessionId, false, control.teacherPlatform);
  changed();
}

export function endAll(): void {
  for (const sessionId of [...viewSessions]) endView(sessionId);
}

/** Teacher -> agent window. */
export function relaySignal(sessionId: string, signal: RtcSignal): void {
  agent?.webContents.send('student:signal', sessionId, signal);
}

export function setControl(sessionId: string, enabled: boolean, teacherPlatform: Platform): void {
  if (!enabled) {
    if (control?.sessionId === sessionId) {
      injector.stop();
      control = null;
      changed();
    }
    return;
  }
  if (!viewSessions.has(sessionId)) return;
  if (process.platform === 'darwin' && !INPUT_DRY_RUN && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // Shows the system prompt once.
    send({
      type: 'error',
      sessionId,
      message: 'Remote control needs Accessibility permission for ClassMonitor Student (System Settings → Privacy & Security → Accessibility).',
    });
    return;
  }
  try {
    injector.start();
  } catch (err) {
    send({ type: 'error', sessionId, message: (err as Error).message });
    return;
  }
  control = { sessionId, teacherPlatform };
  changed();
}

export function inject(sessionId: string, events: InputEvent[]): void {
  if (control && control.sessionId === sessionId) injector.inject(events, control.teacherPlatform);
}
