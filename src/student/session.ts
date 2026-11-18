// Remote view and remote control sessions. The hidden agent window captures and
// encodes the screen; the frames go to the teacher over the encrypted link (no
// separate network path, which school networks and firewalls may block). If
// live video can't start, the screen is sent as still pictures instead, the
// same capture as the thumbnails. The input helper injects the teacher's mouse
// and keyboard.

import { BrowserWindow, desktopCapturer, screen, systemPreferences } from 'electron';
import path from 'node:path';
import { toDesktop } from '../shared/displays';
import { FrameRelay, type ViewerLink } from '../shared/frame-relay';
import type { FrameMeta, InputEvent, Platform, StudentMessage } from '../shared/protocol';
import { INPUT_DRY_RUN, InputInjector } from './input';
import { changed, send, state } from './state';

/** Bits per second when the teacher doesn't say. */
const VIEW_BITRATE = 4_000_000;
/** Live video that hasn't produced a frame by then is given up for still pictures. */
const VIDEO_START_TIMEOUT_MS = 10_000;
/** How long to wait for the list of screens before trying again or giving up. */
const SOURCES_TIMEOUT_MS = 5000;
/** Still pictures: their width and the pause between them. */
const STILL_WIDTH = 1600;
const STILL_PAUSE_MS = 250;
/** The relay's one viewer: the teacher. */
const TEACHER = 'teacher';
/** Testing: send still pictures straight away, as a computer where video can't start would. */
const FORCE_STILLS = process.env.CM_VIEW_STILLS === '1';

interface ViewSession {
  /** The monitor shown. */
  displayId: string;
  mode: 'starting' | 'video' | 'stills';
  relay: FrameRelay<StudentMessage>;
  startTimer: NodeJS.Timeout | null;
  stillsTimer: NodeJS.Timeout | null;
}

/** Open remote-view sessions; `control` holds the one allowed to send input. */
const viewSessions = new Map<string, ViewSession>();
let control: { sessionId: string; teacherPlatform: Platform } | null = null;
const injector = new InputInjector();
let agent: BrowserWindow | null = null;
/** This screen is being shown to the class. */
let presenting = false;

export const viewing = () => viewSessions.size > 0;
export const controlled = () => control !== null;
export const isPresenting = () => presenting;
/** A remote view is sending still pictures (the thumbnails pause meanwhile: same capture). */
export const sendingStills = () => [...viewSessions.values()].some((v) => v.mode === 'stills');
export const owns = (sessionId: string) => viewSessions.has(sessionId);
export const isAgent = (contents: Electron.WebContents) => contents === agent?.webContents;

export function setPresenting(on: boolean): void {
  if (presenting === on) return;
  presenting = on;
  changed();
}

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

function teacherLink(): ViewerLink<StudentMessage> | null {
  const link = state.link;
  if (!link) return null;
  return { send: (msg, payload) => send(msg, payload), buffered: () => link.bufferedAmount, open: () => link.connected };
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** The capture source for a monitor; `thumbnailWidth` 0 for none. Null if the system doesn't answer in time. */
async function sourceFor(display: Electron.Display, thumbnailWidth = 0): Promise<Electron.DesktopCapturerSource | null> {
  const thumbnailSize = thumbnailWidth
    ? { width: thumbnailWidth, height: Math.round((thumbnailWidth * display.size.height) / display.size.width) }
    : { width: 0, height: 0 };
  const sources = await timeout(desktopCapturer.getSources({ types: ['screen'], thumbnailSize }), SOURCES_TIMEOUT_MS);
  if (!sources) return null;
  return sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null;
}

const toAgent = (command: import('./ipc').ViewCommand) => agent?.webContents.send('student:view', command);

export async function startView(sessionId: string, displayId?: string, bitrate = VIEW_BITRATE): Promise<void> {
  const display = displayFor(displayId);
  const relay = new FrameRelay<StudentMessage>(
    teacherLink,
    // Behind on a slow link: once it catches up, video resumes from a fresh keyframe.
    { keyframe: () => requestKeyframe(sessionId), viewers: () => {} },
    (id, meta) => ({ type: 'view-frame', sessionId: id, ...meta }),
  );
  const view: ViewSession = { displayId: String(display.id), mode: 'starting', relay, startTimer: null, stillsTimer: null };
  viewSessions.set(sessionId, view);
  relay.start(sessionId);
  relay.ready(TEACHER, sessionId);
  changed();
  if (FORCE_STILLS) {
    fallBack(sessionId, 'still pictures were asked for (CM_VIEW_STILLS)');
    return;
  }
  view.startTimer = setTimeout(() => fallBack(sessionId, 'live video did not start within 10 seconds'), VIDEO_START_TIMEOUT_MS);
  const source = (await sourceFor(display)) ?? (await sourceFor(display));
  if (viewSessions.get(sessionId) !== view || view.mode !== 'starting') return; // Stopped, or already on stills.
  if (!source) {
    fallBack(sessionId, 'the list of screens did not come back');
    return;
  }
  toAgent({ type: 'start', sessionId, sourceId: source.id, bitrate: Math.max(300_000, Math.min(8_000_000, bitrate)) });
}

/** An encoded frame from the agent window. */
export function viewFrame(sessionId: string, meta: FrameMeta, data: Buffer): void {
  const view = viewSessions.get(sessionId);
  if (!view || view.mode === 'stills') return;
  if (view.mode === 'starting') {
    view.mode = 'video';
    if (view.startTimer) clearTimeout(view.startTimer);
    view.startTimer = null;
    send({ type: 'view-mode', sessionId, mode: 'video' });
  }
  view.relay.frame(sessionId, meta, data);
}

/** Live video isn't possible on this computer: send still pictures instead, and tell the teacher why. */
export function fallBack(sessionId: string, reason: string): void {
  const view = viewSessions.get(sessionId);
  if (!view || view.mode === 'stills') return;
  console.warn(`[view] still pictures instead of video: ${reason}`);
  if (view.startTimer) clearTimeout(view.startTimer);
  view.startTimer = null;
  view.mode = 'stills';
  toAgent({ type: 'stop', sessionId });
  send({ type: 'view-mode', sessionId, mode: 'stills', reason: reason.slice(0, 200) });
  changed();
  const next = async (): Promise<void> => {
    if (viewSessions.get(sessionId) !== view) return;
    const source = await sourceFor(displayFor(view.displayId), STILL_WIDTH);
    if (viewSessions.get(sessionId) !== view) return;
    if (source && !source.thumbnail.isEmpty()) {
      view.relay.frame(sessionId, { codec: 'jpeg', key: true, timestamp: Date.now() * 1000 }, source.thumbnail.toJPEG(70));
    }
    view.stillsTimer = setTimeout(() => void next(), STILL_PAUSE_MS);
  };
  void next();
}

/** The teacher (or the pacing) needs a keyframe; still pictures are all keyframes already. */
export function requestKeyframe(sessionId: string): void {
  if (viewSessions.get(sessionId)?.mode !== 'stills') toAgent({ type: 'keyframe', sessionId });
}

export function setBitrate(sessionId: string, bitrate: number): void {
  if (viewSessions.has(sessionId)) toAgent({ type: 'bitrate', sessionId, bitrate: Math.max(300_000, Math.min(8_000_000, bitrate)) });
}

export function endView(sessionId: string): void {
  const view = viewSessions.get(sessionId);
  if (!view) return;
  viewSessions.delete(sessionId);
  if (view.startTimer) clearTimeout(view.startTimer);
  if (view.stillsTimer) clearTimeout(view.stillsTimer);
  view.relay.stop();
  toAgent({ type: 'stop', sessionId });
  if (control?.sessionId === sessionId) setControl(sessionId, false, control.teacherPlatform);
  changed();
}

export function endAll(): void {
  for (const sessionId of [...viewSessions.keys()]) endView(sessionId);
  setPresenting(false);
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
      message: 'Remote control needs Accessibility permission for Дидбон Хонанда (System Settings → Privacy & Security → Accessibility).',
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
  const { bounds } = displayFor(viewSessions.get(sessionId)?.displayId);
  injector.inject(events, control.teacherPlatform, (nx, ny) => {
    const point = toDesktop(bounds, nx, ny);
    return process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  });
}
