// Full-size remote view of one student, with optional remote control.

import { Peer } from '../../renderer-shared/peer';
import type { InputEvent, RtcSignal } from '../../shared/protocol';
import { $, api, OS_LABEL } from './dom';
import * as store from './store';
import type { Student } from './store';

interface Viewer {
  id: string;
  sessionId: string;
  /** The student's monitor being shown; undefined means their main one. */
  displayId: string | undefined;
  peer: Peer;
  control: boolean;
  buttons: Set<number>;
  keys: Set<string>;
}

let viewer: Viewer | null = null;
let onToggleLock: (s: Student) => void = () => {};
/** Dialogs that, while open, keep keystrokes in the console instead of the student. */
let dialogOpen: () => boolean = () => false;

const viewerEl = $('#viewer');
const stage = $('#stage');
const video = $<HTMLVideoElement>('#viewer-video');
const stageStatus = $('#stage-status');

export function init(options: { toggleLock: (s: Student) => void; dialogOpen: () => boolean }): void {
  onToggleLock = options.toggleLock;
  dialogOpen = options.dialogOpen;
  store.onChange((id) => {
    if (!viewer || (id !== null && id !== viewer.id)) return;
    renderStatus();
    renderScreens();
  });
}

export const viewingId = () => viewer?.id ?? null;

export function open(s: Student, control: boolean, displayId?: string): void {
  close();
  const id = s.id;
  const sessionId = crypto.randomUUID();
  const peer = new Peer((signal) => api.signal(id, sessionId, signal));
  viewer = { id, sessionId, displayId, peer, control: false, buttons: new Set(), keys: new Set() };

  peer.pc.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  peer.pc.onconnectionstatechange = () => {
    const st = peer.pc.connectionState;
    if (st === 'failed') stageStatus.textContent = 'Connection failed. Close and try again.';
    else if (st === 'disconnected') stageStatus.textContent = 'Reconnecting…';
    else if (st === 'connected') stageStatus.textContent = '';
  };
  video.onplaying = () => (stageStatus.textContent = '');

  stageStatus.textContent = 'Connecting…';
  $('#viewer-name').textContent = store.displayName(s);
  $('#viewer-meta').textContent = `${s.username} · ${OS_LABEL[s.platform] ?? s.platform} · ${s.address}`;
  renderStatus();
  renderScreens();
  viewerEl.hidden = false;
  api.viewStart(id, sessionId, displayId);
  if (control) setControl(true);
}

/** Tabs for each of the student's monitors, main one first; hidden with a single monitor. */
function renderScreens(): void {
  const s = viewer && store.get(viewer.id);
  const tabs = $('#viewer-screens');
  const displays = [...(s?.displays ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary) || a.bounds.x - b.bounds.x);
  tabs.hidden = displays.length < 2;
  if (!viewer || displays.length < 2) return;
  const showing = viewer.displayId ?? displays[0].id;
  tabs.replaceChildren(
    ...displays.map((d, i) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: `Screen ${i + 1}` });
      button.title = `${d.bounds.width}×${d.bounds.height}${d.primary ? ' (main screen)' : ''}`;
      button.dataset.display = d.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(d.id === showing));
      button.addEventListener('click', () => switchTo(d.id));
      return button;
    }),
  );
}

/** Restarts the stream on another monitor, keeping remote control if it was on. */
function switchTo(displayId: string): void {
  const s = viewer && store.get(viewer.id);
  if (!s || !viewer) return;
  const showing = viewer.displayId ?? s.displays.find((d) => d.primary)?.id;
  if (showing !== displayId) open(s, viewer.control, displayId);
}

export function close(): void {
  if (!viewer) return;
  setControl(false);
  api.viewStop(viewer.id, viewer.sessionId);
  viewer.peer.close();
  viewer = null;
  video.srcObject = null;
  viewerEl.hidden = true;
}

/** Returns true if the signal belonged to the open viewer. */
export function handleSignal(sessionId: string, signal: RtcSignal): boolean {
  if (viewer?.sessionId !== sessionId) return false;
  viewer.peer.handle(signal);
  return true;
}

export function studentLeft(id: string): void {
  if (viewer?.id !== id) return;
  stageStatus.textContent = 'This computer disconnected.';
  setControl(false);
}

/** The student reported a problem with this session (e.g. no Accessibility permission). */
export function sessionFailed(sessionId: string | undefined): void {
  if (viewer && sessionId === viewer.sessionId) setControl(false);
}

function setControl(enabled: boolean): void {
  if (!viewer || viewer.control === enabled) return;
  if (!enabled) releaseHeld();
  viewer.control = enabled;
  api.control(viewer.id, viewer.sessionId, enabled);
  stage.classList.toggle('controlling', enabled);
  $('#control-hint').hidden = !enabled;
  $('#viewer-control').querySelector('span')!.textContent = enabled ? 'Release control' : 'Take control';
  if (enabled) stage.focus();
}

function renderStatus(): void {
  const s = viewer && store.get(viewer.id);
  if (!s) return;
  const site = s.web?.url ? ` · ${s.web.url}` : '';
  $('#viewer-meta').textContent = `${s.username} · ${OS_LABEL[s.platform] ?? s.platform} · ${s.address}${site}`;
  const locked = s.policy.lock !== null;
  const lock = $('#viewer-lock');
  lock.querySelector('span')!.textContent = locked ? 'Unlock' : 'Lock';
  lock.querySelector('use')!.setAttribute('href', locked ? '#i-unlock' : '#i-lock');
}

$('#viewer-close').addEventListener('click', close);
$('#viewer-control').addEventListener('click', () => setControl(!viewer?.control));
$('#viewer-lock').addEventListener('click', () => {
  const s = viewer && store.get(viewer.id);
  if (s) onToggleLock(s);
});

// All input travels in one ordered queue so a quick Shift+click or click-then-type
// arrives in the order it happened. Moves and scrolls are batched (~60/s, with
// consecutive moves merged); buttons and keys flush immediately.
let pending: InputEvent[] = [];
let flushTimer: number | null = null;

function queueInput(event: InputEvent): void {
  if (!viewer?.control) return;
  const last = pending[pending.length - 1];
  if (event.t === 'move' && last?.t === 'move') pending[pending.length - 1] = event;
  else pending.push(event);
  if (event.t === 'button' || event.t === 'key') flushInput();
  else flushTimer ??= window.setTimeout(flushInput, 16);
}

function flushInput(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  if (viewer?.control && pending.length) api.input(viewer.id, viewer.sessionId, pending);
  pending = [];
}

for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (!viewer?.control || dialogOpen() || !e.code) {
        if (type === 'keydown' && e.key === 'Escape' && viewer && !viewer.control && !dialogOpen()) close();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const down = type === 'keydown';
      if (down) viewer.keys.add(e.code);
      else viewer.keys.delete(e.code);
      queueInput({ t: 'key', code: e.code, down });
    },
    true,
  );
}
// Switching away mid-keystroke must not leave keys or buttons stuck down on the student.
window.addEventListener('blur', () => releaseHeld());

/** Maps a pointer position to 0..1 within the letterboxed video picture. */
function videoPoint(e: MouseEvent): { x: number; y: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const left = rect.left + (rect.width - vw * scale) / 2;
  const top = rect.top + (rect.height - vh * scale) / 2;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { x: clamp((e.clientX - left) / (vw * scale)), y: clamp((e.clientY - top) / (vh * scale)) };
}

function releaseButtons(): void {
  if (!viewer) return;
  for (const button of viewer.buttons) queueInput({ t: 'button', button: button as 0 | 1 | 2, down: false, x: -1, y: -1, clicks: 1 });
  viewer.buttons.clear();
  flushInput();
}

function releaseHeld(): void {
  if (!viewer) return;
  releaseButtons();
  for (const code of viewer.keys) queueInput({ t: 'key', code, down: false });
  viewer.keys.clear();
}

stage.addEventListener('mousemove', (e) => {
  const p = videoPoint(e);
  if (p) queueInput({ t: 'move', ...p });
});
for (const type of ['mousedown', 'mouseup'] as const) {
  stage.addEventListener(type, (e) => {
    if (!viewer?.control || e.button > 2) return;
    e.preventDefault();
    stage.focus();
    const p = videoPoint(e);
    if (!p) return;
    const down = type === 'mousedown';
    if (down) viewer.buttons.add(e.button);
    else viewer.buttons.delete(e.button);
    queueInput({ t: 'button', button: e.button as 0 | 1 | 2, down, ...p, clicks: Math.max(1, e.detail) });
  });
}
stage.addEventListener('contextmenu', (e) => viewer?.control && e.preventDefault());
stage.addEventListener(
  'wheel',
  (e) => {
    if (!viewer?.control) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    queueInput({ t: 'wheel', dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) });
  },
  { passive: false },
);
stage.addEventListener('mouseleave', releaseButtons);
