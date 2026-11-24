// Full-size remote view of one student, with optional remote control. The
// student's computer encodes its screen and sends it over the encrypted link;
// it's drawn here on a canvas (live video, or still pictures if video couldn't
// start on that computer). From here the teacher can show it to the class.

import { ScreenDecoder } from '../../renderer-shared/screen-decoder';
import { orderDisplays } from '../../shared/displays';
import type { ControlBlock, FrameMeta, InputEvent } from '../../shared/protocol';
import { $, api, OS_LABEL } from './dom';
import * as store from './store';
import type { Student } from './store';

interface Viewer {
  id: string;
  sessionId: string;
  /** The student's monitor being shown; undefined means their main one. */
  displayId: string | undefined;
  decoder: ScreenDecoder;
  waitTimer: number;
  control: boolean;
  buttons: Set<number>;
  keys: Set<string>;
}

/** No picture by then: say so, rather than "Connecting…" for ever. */
const WAIT_MS = 15_000;

let viewer: Viewer | null = null;
let onToggleLock: (s: Student) => void = () => {};
let onToggleExhibit: (s: Student, sessionId: string) => void = () => {};
let exhibiting: (sessionId: string) => boolean = () => false;
/** Dialogs that, while open, keep keystrokes in the console instead of the student. */
let dialogOpen: () => boolean = () => false;

const viewerEl = $('#viewer');
const stage = $('#stage');
const canvas = $<HTMLCanvasElement>('#viewer-screen');
const stageStatus = $('#stage-status');
const stageNote = $('#stage-note');
const stageBlocked = $('#stage-blocked');

/**
 * What the student's computer says keeps remote control from the window in
 * front. The OS drops that input without a word, so without this the teacher
 * just sees a frozen picture or clicks that do nothing.
 */
const BLOCKED: Record<ControlBlock, { title: string; text: string }> = {
  'secure-desktop': {
    title: 'Windows is showing a security prompt',
    text: 'A User Account Control prompt (or the Ctrl+Alt+Del or lock screen) is up on this computer. Windows keeps it away from remote control and screen sharing, so the picture stands still and clicks do nothing until someone at the computer answers it.',
  },
  elevated: {
    title: 'The window in front runs as administrator',
    text: "Windows doesn't let remote control click or type in programs running as administrator (such as System Properties, Computer Management or user account tools). Close it at the student's computer, or click another window to carry on.",
  },
  'password-prompt': {
    title: 'macOS is asking for a password',
    text: "Password prompts don't show in remote view and may not accept typing from remote control. Answer or cancel it at the student's computer.",
  },
};

export function init(options: {
  toggleLock: (s: Student) => void;
  dialogOpen: () => boolean;
  /** Shows this remote view to the class, or stops showing it. */
  toggleExhibit: (s: Student, sessionId: string) => void;
  exhibiting: (sessionId: string) => boolean;
}): void {
  onToggleLock = options.toggleLock;
  dialogOpen = options.dialogOpen;
  onToggleExhibit = options.toggleExhibit;
  exhibiting = options.exhibiting;
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
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  delete canvas.dataset.frames;
  const decoder = new ScreenDecoder(canvas, {
    needKeyframe: () => api.viewKeyframe(id, sessionId),
    shown: (count) => {
      if (count === 1 && viewer?.sessionId === sessionId) stageStatus.textContent = '';
    },
    failed: () => (stageStatus.textContent = "This computer can't show the student's screen. Close and try again."),
  });
  const waitTimer = window.setTimeout(() => {
    if (viewer?.sessionId === sessionId && !decoder.frames) {
      stageStatus.textContent = `Still waiting for ${store.displayName(s)}'s screen. Their computer may be busy, asleep or on an older version of Дидбон.`;
    }
  }, WAIT_MS);
  viewer = { id, sessionId, displayId, decoder, waitTimer, control: false, buttons: new Set(), keys: new Set() };

  stageStatus.textContent = 'Connecting…';
  stageNote.hidden = true;
  stageBlocked.hidden = true;
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
  const displays = orderDisplays(s?.displays ?? []);
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
  viewer.decoder.close();
  clearTimeout(viewer.waitTimer);
  viewer = null;
  viewerEl.hidden = true;
}

/** A frame of the student's screen. */
export function handleFrame(sessionId: string, meta: FrameMeta, data: Uint8Array): void {
  if (viewer?.sessionId === sessionId) viewer.decoder.push(meta, data);
}

/** The student's computer says how it sends its screen. */
export function setMode(sessionId: string, mode: 'video' | 'stills', reason?: string): void {
  if (viewer?.sessionId !== sessionId) return;
  stageNote.hidden = mode === 'video';
  stageNote.textContent = mode === 'stills' ? `Still pictures: live video couldn't start on this computer${reason ? ` (${reason})` : ''}.` : '';
}

/** Showing to the class started or stopped: the button follows. */
export function renderExhibit(): void {
  const showing = viewer !== null && exhibiting(viewer.sessionId);
  const button = $('#viewer-exhibit');
  button.querySelector('span')!.textContent = showing ? 'Stop showing' : 'Show to class';
  button.classList.toggle('danger', showing);
}

export function studentLeft(id: string): void {
  if (viewer?.id !== id) return;
  stageStatus.textContent = 'This computer disconnected.';
  setControl(false);
}

/** While controlling: what keeps the teacher's input from the student's window in front, or null once nothing does. */
export function setBlocked(sessionId: string, reason: ControlBlock | null): void {
  if (viewer?.sessionId !== sessionId) return;
  const shown = viewer.control && reason ? BLOCKED[reason] : null;
  stageBlocked.hidden = !shown;
  $('#stage-blocked-title').textContent = shown?.title ?? '';
  $('#stage-blocked-text').textContent = shown?.text ?? '';
}

/** The student reported a problem with this session (e.g. no Accessibility permission). */
export function sessionFailed(sessionId: string | undefined): void {
  if (viewer && sessionId === viewer.sessionId) setControl(false);
}

function setControl(enabled: boolean): void {
  if (!viewer || viewer.control === enabled) return;
  if (!enabled) {
    releaseHeld();
    stageBlocked.hidden = true;
  }
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
  renderExhibit();
  const site = s.web?.url ? ` · ${s.web.url}` : '';
  $('#viewer-meta').textContent = `${s.username} · ${OS_LABEL[s.platform] ?? s.platform} · ${s.address}${site}`;
  const locked = s.policy.lock !== null;
  const lock = $('#viewer-lock');
  lock.querySelector('span')!.textContent = locked ? 'Unlock' : 'Lock';
  lock.querySelector('use')!.setAttribute('href', locked ? '#i-unlock' : '#i-lock');
}

$('#viewer-close').addEventListener('click', close);
$('#viewer-exhibit').addEventListener('click', () => {
  const s = viewer && store.get(viewer.id);
  if (s && viewer) onToggleExhibit(s, viewer.sessionId);
});
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

/** Maps a pointer position to 0..1 within the letterboxed picture. */
function videoPoint(e: MouseEvent): { x: number; y: number } | null {
  if (!viewer?.decoder.frames) return null;
  const vw = canvas.width;
  const vh = canvas.height;
  if (!vw || !vh) return null;
  const rect = canvas.getBoundingClientRect();
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
