// Remote view and remote control sessions. The hidden agent window streams the
// screen; the input helper injects the teacher's mouse and keyboard.

import { BrowserWindow, desktopCapturer, screen, systemPreferences } from 'electron';
import path from 'node:path';
import { toDesktop } from '../shared/displays';
import type { InputEvent, Platform, RtcSignal } from '../shared/protocol';
import { INPUT_DRY_RUN, InputInjector } from './input';
import { changed, send } from './state';

/** Open remote-view sessions and the monitor each shows; `control` holds the one allowed to send input. */
const viewSessions = new Map<string, string>();
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

/** The requested monitor, or the primary one if it's unknown or was unplugged. */
function displayFor(displayId: string | undefined): Electron.Display {
  return screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
}

export async function startView(sessionId: string, displayId?: string): Promise<void> {
  const display = displayFor(displayId);
  viewSessions.set(sessionId, String(display.id));
  changed();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!viewSessions.has(sessionId)) return; // Stopped while we looked.
  if (!source) {
    send({ type: 'error', sessionId, message: 'Could not find a screen to share.' });
    endView(sessionId);
    return;
  }
  agent?.webContents.send('student:view', { type: 'start', sessionId, sourceId: source.id });
}

export function endView(sessionId: string): void {
  if (!viewSessions.delete(sessionId)) return;
  agent?.webContents.send('student:view', { type: 'stop', sessionId });
  if (control?.sessionId === sessionId) setControl(sessionId, false, control.teacherPlatform);
  changed();
}

export function endAll(): void {
  for (const sessionId of [...viewSessions.keys()]) endView(sessionId);
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
  if (!control || control.sessionId !== sessionId) return;
  // Pointer positions arrive as 0..1 across the monitor being viewed; the
  // helper wants desktop coordinates (points on macOS, physical pixels on Windows).
  const { bounds } = displayFor(viewSessions.get(sessionId));
  injector.inject(events, control.teacherPlatform, (nx, ny) => {
    const point = toDesktop(bounds, nx, ny);
    return process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  });
}
