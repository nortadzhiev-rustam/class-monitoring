import { Peer } from '../../renderer-shared/peer';
import type { InputEvent, RtcSignal } from '../../shared/protocol';
import type { StudentStatus, StudentSummary, TeacherApi, TeacherEvent, TeacherState } from '../ipc';

declare global {
  interface Window {
    teacher: TeacherApi;
  }
}

const api = window.teacher;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;

const BROADCAST_BITRATE = 2_500_000;
const OS_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

let state: TeacherState;

// ---------------------------------------------------------------- grid

interface Card {
  el: HTMLElement;
  img: HTMLImageElement;
  summary: StudentSummary;
  thumbUrl: string | null;
}

const cards = new Map<string, Card>();
const grid = $('#grid');
const cardTemplate = $<HTMLTemplateElement>('#card-template');

function displayName(s: StudentSummary): string {
  return s.info.hostname.replace(/\.local$/, '');
}

function upsertCard(summary: StudentSummary): void {
  let card = cards.get(summary.info.id);
  if (!card) {
    const el = (cardTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    card = { el, img: el.querySelector('img')!, summary, thumbUrl: null };
    cards.set(summary.info.id, card);
    const id = summary.info.id;
    el.querySelector('.screen')!.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      const current = cards.get(id)?.summary;
      if (!current) return;
      if (action === 'lock') toggleLock(current);
      else openViewer(current, action === 'control');
    });
  }
  card.summary = summary;
  card.el.querySelector('.name')!.textContent = displayName(summary);
  card.el.querySelector('.meta')!.textContent = `${summary.info.username} · ${summary.address}`;
  card.el.querySelector('.os')!.textContent = OS_LABEL[summary.info.platform] ?? summary.info.platform;
  renderStatus(card);
  placeCard(card);
  updateCounts();
}

/** Keeps cards sorted by computer name so the layout matches the room's order. */
function placeCard(card: Card): void {
  const name = displayName(card.summary).toLowerCase();
  const next = [...cards.values()]
    .filter((c) => c !== card && c.el.isConnected && displayName(c.summary).toLowerCase() > name)
    .sort((a, b) => displayName(a.summary).localeCompare(displayName(b.summary)))[0];
  if (next) grid.insertBefore(card.el, next.el);
  else if (card.el.parentElement !== grid || card.el.nextElementSibling) grid.append(card.el);
}

function renderStatus(card: Card): void {
  const { locked, controlled } = card.summary.status;
  card.el.classList.toggle('locked', locked);
  card.el.classList.toggle('controlled', controlled);
  card.el.querySelector('.pill')!.textContent = controlled ? 'Being controlled' : locked ? 'Locked' : '';
  const lockChip = card.el.querySelector('[data-action="lock"]')!;
  lockChip.querySelector('span')!.textContent = locked ? 'Unlock' : 'Lock';
  lockChip.querySelector('use')!.setAttribute('href', locked ? '#i-unlock' : '#i-lock');
}

function removeCard(id: string): void {
  const card = cards.get(id);
  if (!card) return;
  if (card.thumbUrl) URL.revokeObjectURL(card.thumbUrl);
  card.el.remove();
  cards.delete(id);
  updateCounts();
}

function showThumb(id: string, jpeg: Uint8Array): void {
  const card = cards.get(id);
  if (!card) return;
  const previous = card.thumbUrl;
  card.thumbUrl = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
  card.img.src = card.thumbUrl;
  if (previous) card.img.decode().finally(() => URL.revokeObjectURL(previous));
}

function updateCounts(): void {
  const n = cards.size;
  $('#count').textContent = `${n} online`;
  $('#empty').hidden = n > 0;
  if (broadcast) $('#banner-text').textContent = `Showing your screen to ${n} student${n === 1 ? '' : 's'}`;
}

const zoom = $<HTMLInputElement>('#zoom');
function applyZoom(): void {
  document.documentElement.style.setProperty('--card-min', `${zoom.value}px`);
  try {
    localStorage.setItem('zoom', zoom.value);
  } catch {
    // Storage unavailable; the size just isn't remembered.
  }
}
try {
  zoom.value = localStorage.getItem('zoom') ?? zoom.value;
} catch {
  // Use the default size.
}
zoom.addEventListener('input', applyZoom);
applyZoom();

// ---------------------------------------------------------------- toasts

function toast(message: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

// ---------------------------------------------------------------- locking

const lockDialog = $<HTMLDialogElement>('#lock-dialog');
const lockMessage = $<HTMLTextAreaElement>('#lock-message');
let lockTarget: string | null = null;

function askLock(target: StudentSummary | null): void {
  lockTarget = target?.info.id ?? null;
  $('#lock-title').textContent = target ? `Lock ${displayName(target)}` : 'Lock all screens';
  lockDialog.returnValue = '';
  lockDialog.showModal();
  lockMessage.select();
}

lockDialog.addEventListener('close', () => {
  if (lockDialog.returnValue !== 'ok') return;
  const message = lockMessage.value.trim();
  if (lockTarget) api.lock(lockTarget, message);
  else api.lockAll(message);
});

function toggleLock(s: StudentSummary): void {
  if (s.status.locked) api.unlock(s.info.id);
  else askLock(s);
}

$('#lock-all').addEventListener('click', () => askLock(null));
$('#unlock-all').addEventListener('click', () => api.unlockAll());

// ---------------------------------------------------------------- broadcast

let broadcast: { sessionId: string; stream: MediaStream; peers: Map<string, Peer> } | null = null;

async function startBroadcast(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch (err) {
    toast(
      state.platform === 'darwin'
        ? 'Could not capture your screen. Allow Screen Recording for ClassMonitor Teacher in System Settings → Privacy & Security, then restart it.'
        : `Could not capture your screen: ${(err as Error).message}`,
    );
    return;
  }
  const sessionId = crypto.randomUUID();
  broadcast = { sessionId, stream, peers: new Map() };
  stream.getVideoTracks()[0]?.addEventListener('ended', stopBroadcast);
  api.broadcastStart(sessionId);
  renderBroadcast();
}

/** A student's display window is ready; send it the teacher's screen. */
function connectBroadcast(id: string, sessionId: string): void {
  if (!broadcast || broadcast.sessionId !== sessionId) return;
  broadcast.peers.get(id)?.close();
  const peer = new Peer((signal) => api.signal(id, sessionId, signal));
  peer.addScreen(broadcast.stream, BROADCAST_BITRATE);
  broadcast.peers.set(id, peer);
  peer.offer().catch((err) => console.error('[broadcast] offer failed', err));
}

function stopBroadcast(): void {
  if (!broadcast) return;
  for (const peer of broadcast.peers.values()) peer.close();
  for (const track of broadcast.stream.getTracks()) track.stop();
  broadcast = null;
  api.broadcastStop();
  renderBroadcast();
}

function renderBroadcast(): void {
  const button = $('#broadcast');
  button.classList.toggle('primary', !broadcast);
  button.classList.toggle('danger', !!broadcast);
  button.querySelector('span')!.textContent = broadcast ? 'Stop showing' : 'Show my screen';
  $('#banner').hidden = !broadcast;
  updateCounts();
}

$('#broadcast').addEventListener('click', () => (broadcast ? stopBroadcast() : void startBroadcast()));
$('#banner-stop').addEventListener('click', stopBroadcast);

// ---------------------------------------------------------------- viewer & remote control

interface Viewer {
  id: string;
  sessionId: string;
  peer: Peer;
  control: boolean;
  buttons: Set<number>;
  keys: Set<string>;
}

let viewer: Viewer | null = null;
const viewerEl = $('#viewer');
const stage = $('#stage');
const video = $<HTMLVideoElement>('#viewer-video');
const stageStatus = $('#stage-status');

function openViewer(s: StudentSummary, control: boolean): void {
  closeViewer();
  const id = s.info.id;
  const sessionId = crypto.randomUUID();
  const peer = new Peer((signal) => api.signal(id, sessionId, signal));
  viewer = { id, sessionId, peer, control: false, buttons: new Set(), keys: new Set() };

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
  $('#viewer-name').textContent = displayName(s);
  $('#viewer-meta').textContent = `${s.info.username} · ${OS_LABEL[s.info.platform] ?? s.info.platform} · ${s.address}`;
  renderViewerStatus(s.status);
  viewerEl.hidden = false;
  api.viewStart(id, sessionId);
  if (control) setControl(true);
}

function closeViewer(): void {
  if (!viewer) return;
  setControl(false);
  api.viewStop(viewer.id, viewer.sessionId);
  viewer.peer.close();
  viewer = null;
  video.srcObject = null;
  viewerEl.hidden = true;
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

function renderViewerStatus(status: StudentStatus): void {
  const lock = $('#viewer-lock');
  lock.querySelector('span')!.textContent = status.locked ? 'Unlock' : 'Lock';
  lock.querySelector('use')!.setAttribute('href', status.locked ? '#i-unlock' : '#i-lock');
}

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-control').addEventListener('click', () => setControl(!viewer?.control));
$('#viewer-lock').addEventListener('click', () => {
  const s = viewer && cards.get(viewer.id)?.summary;
  if (s) toggleLock(s);
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

const dialogOpen = () => lockDialog.open || settingsDialog.open;

for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (!viewer?.control || dialogOpen() || !e.code) {
        if (type === 'keydown' && e.key === 'Escape' && viewer && !viewer.control && !dialogOpen()) closeViewer();
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

// ---------------------------------------------------------------- settings

const settingsDialog = $<HTMLDialogElement>('#settings-dialog');
const setRoom = $<HTMLInputElement>('#set-room');
const setName = $<HTMLInputElement>('#set-name');
const setKey = $<HTMLInputElement>('#set-key');

function studentConfigSnippet(): string {
  const config = {
    room: setRoom.value.trim(),
    classKey: setKey.value.trim(),
    teacherHost: state.addresses[0] ?? '',
  };
  return JSON.stringify(config, null, 2);
}

function openSettings(): void {
  setRoom.value = state.settings.room;
  setName.value = state.settings.teacherName;
  setKey.value = state.settings.classKey;
  $('#set-snippet').textContent = studentConfigSnippet();
  $('#settings-error').hidden = true;
  settingsDialog.returnValue = '';
  settingsDialog.showModal();
}

$('#config-path-win').textContent = 'C:\\ProgramData\\ClassMonitor\\student.json';
$('#config-path-mac').textContent = '/Library/Application Support/ClassMonitor/student.json';
for (const input of [setRoom, setKey]) input.addEventListener('input', () => ($('#set-snippet').textContent = studentConfigSnippet()));
$('#copy-key').addEventListener('click', () => api.copy(setKey.value.trim()));
$('#new-key').addEventListener('click', async () => {
  setKey.value = await api.generateKey();
  $('#set-snippet').textContent = studentConfigSnippet();
});

$('#settings-form').addEventListener('submit', async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save') return;
  e.preventDefault();
  closeViewer();
  stopBroadcast();
  try {
    const next = await api.saveSettings({ room: setRoom.value, teacherName: setName.value, classKey: setKey.value });
    settingsDialog.close();
    for (const id of [...cards.keys()]) removeCard(id);
    applyState(next);
  } catch (err) {
    const el = $('#settings-error');
    el.textContent = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    el.hidden = false;
  }
});

$('#settings').addEventListener('click', openSettings);
$('#room').addEventListener('click', openSettings);
$('#empty-settings').addEventListener('click', openSettings);

// ---------------------------------------------------------------- events

function applyState(next: TeacherState): void {
  state = next;
  $('#room-name').textContent = state.settings.room;
  $('#empty-room').textContent = state.settings.room;
  $('#empty-key').textContent = state.settings.classKey;
  for (const s of state.students) upsertCard(s);
  updateCounts();
}

function handleSignal(id: string, sessionId: string, signal: RtcSignal): void {
  if (viewer?.sessionId === sessionId) viewer.peer.handle(signal);
  else if (broadcast?.sessionId === sessionId) broadcast.peers.get(id)?.handle(signal);
}

api.onEvent((event: TeacherEvent) => {
  switch (event.type) {
    case 'joined':
      upsertCard(event.student);
      break;
    case 'left':
      removeCard(event.id);
      broadcast?.peers.get(event.id)?.close();
      broadcast?.peers.delete(event.id);
      if (viewer?.id === event.id) {
        stageStatus.textContent = 'This computer disconnected.';
        setControl(false);
      }
      break;
    case 'status': {
      const card = cards.get(event.id);
      if (!card) break;
      card.summary = { ...card.summary, status: event.status };
      renderStatus(card);
      if (viewer?.id === event.id) renderViewerStatus(event.status);
      break;
    }
    case 'thumb':
      showThumb(event.id, event.jpeg);
      break;
    case 'signal':
      handleSignal(event.id, event.sessionId, event.signal);
      break;
    case 'broadcast-ready':
      connectBroadcast(event.id, event.sessionId);
      break;
    case 'student-error': {
      const name = cards.get(event.id) ? displayName(cards.get(event.id)!.summary) : 'A student computer';
      toast(`${name}: ${event.message}`);
      if (viewer?.sessionId && viewer.sessionId === event.sessionId) setControl(false);
      break;
    }
  }
});

void api.state().then((initial) => {
  document.body.classList.add(initial.platform);
  applyState(initial);
});
