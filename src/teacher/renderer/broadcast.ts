// "Show my screen": streams the teacher's screen to the targeted students.
// With several monitors the teacher picks one, and can switch while showing.

import { Peer } from '../../renderer-shared/peer';
import type { RtcSignal } from '../../shared/protocol';
import type { TeacherScreen } from '../ipc';
import { $, api, toast } from './dom';
import { showMenu } from './menu';
import type { Resolved } from './targets';

// Every student gets their own copy of the stream, so the class shares one
// budget: up to 12 students get the full rate, a class of 30 about 1 Mbps each,
// and the teacher's network link never carries more than ~30 Mbps.
const CLASS_BUDGET = 30_000_000;
const MAX_PER_STUDENT = 2_500_000;
const MIN_PER_STUDENT = 500_000;

/** Bits per second for each student when `watching` students share the budget. */
export const perStudentBitrate = (watching: number) =>
  Math.max(MIN_PER_STUDENT, Math.min(MAX_PER_STUDENT, Math.floor(CLASS_BUDGET / Math.max(1, watching))));

interface Broadcast {
  sessionId: string;
  stream: MediaStream;
  /** The monitor being shown. */
  displayId: string | undefined;
  peers: Map<string, Peer>;
  bitrate: number;
  label: string;
}

let broadcast: Broadcast | null = null;
let platform = '';
let screens: TeacherScreen[] = [];
/** Counts screen switches, so only the last of several quick clicks takes effect. */
let switches = 0;

export function init(teacherPlatform: string, teacherScreens: TeacherScreen[]): void {
  platform = teacherPlatform;
  screens = teacherScreens;
  $('#banner-stop').addEventListener('click', stop);
  render();
}

/** Monitors were plugged in, unplugged or rearranged. */
export function setScreens(list: TeacherScreen[]): void {
  screens = list;
  // The monitor being shown was unplugged: carry on with the main one.
  if (broadcast && list.length && !list.some((s) => s.id === broadcast?.displayId)) void switchScreen(list[0].id);
  render();
}

/** "Screen 2: DELL U2720Q"; the main screen also says "(main)". */
const screenName = (s: TeacherScreen, i: number) => `Screen ${i + 1}${s.label ? `: ${s.label}` : ''}${s.primary ? ' (main)' : ''}`;

/** The toolbar button: stops showing, or starts, first asking which screen when there are several. */
export function toggle(anchor: HTMLElement, to: () => Resolved): void {
  if (broadcast) stop();
  else if (screens.length < 2) void start(to());
  else showMenu(anchor, screens.map((s, i) => ({ label: screenName(s, i), action: () => void start(to(), s.id) })));
}

/** Captures one monitor (the main one when undefined); null, after telling the teacher, if that fails. */
async function capture(displayId: string | undefined): Promise<MediaStream | null> {
  try {
    await api.shareScreen(displayId ?? null);
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch (err) {
    toast(
      platform === 'darwin'
        ? 'Could not capture your screen. Allow Screen Recording for ClassMonitor Teacher in System Settings → Privacy & Security, then restart it.'
        : `Could not capture your screen: ${(err as Error).message}`,
    );
    return null;
  }
}

const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());

export async function start(to: Resolved, displayId?: string): Promise<void> {
  const stream = await capture(displayId);
  if (!stream) return;
  const sessionId = crypto.randomUUID();
  broadcast = {
    sessionId,
    stream,
    displayId: displayId ?? screens.find((s) => s.primary)?.id,
    peers: new Map(),
    bitrate: perStudentBitrate(1),
    label: to.label,
  };
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  api.broadcastStart(to.target, sessionId);
  render();
}

/** Shows another monitor; students stay connected and their picture just changes. */
async function switchScreen(displayId: string): Promise<void> {
  const session = broadcast;
  if (!session || session.displayId === displayId) return;
  const ticket = ++switches;
  const stream = await capture(displayId);
  if (!stream) return;
  if (ticket !== switches || broadcast !== session) {
    stopTracks(stream);
    return;
  }
  const old = session.stream;
  old.getVideoTracks()[0]?.removeEventListener('ended', stop);
  session.stream = stream;
  session.displayId = displayId;
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  for (const peer of session.peers.values()) peer.replaceScreen(stream);
  stopTracks(old);
  render();
}

/** A student's display window is ready; send it the teacher's screen. */
export function connect(id: string, sessionId: string): void {
  if (!broadcast || broadcast.sessionId !== sessionId) return;
  broadcast.peers.get(id)?.close();
  const peer = new Peer((signal) => api.signal(id, sessionId, signal));
  broadcast.peers.set(id, peer);
  peer.addScreen(broadcast.stream, perStudentBitrate(broadcast.peers.size));
  peer.offer().catch((err) => console.error('[broadcast] offer failed', err));
  rebalance(peer);
}

/** Re-splits the class budget when a student starts or stops watching (`fresh` already has its share). */
function rebalance(fresh?: Peer): void {
  if (!broadcast) return;
  const bitrate = perStudentBitrate(broadcast.peers.size);
  if (bitrate === broadcast.bitrate) return;
  broadcast.bitrate = bitrate;
  for (const peer of broadcast.peers.values()) if (peer !== fresh) peer.setMaxBitrate(bitrate);
}

export function handleSignal(id: string, sessionId: string, signal: RtcSignal): boolean {
  if (broadcast?.sessionId !== sessionId) return false;
  broadcast.peers.get(id)?.handle(signal);
  return true;
}

export function studentLeft(id: string): void {
  broadcast?.peers.get(id)?.close();
  if (broadcast?.peers.delete(id)) rebalance();
}

export function stop(): void {
  if (!broadcast) return;
  for (const peer of broadcast.peers.values()) peer.close();
  stopTracks(broadcast.stream);
  broadcast = null;
  api.broadcastStop();
  render();
}

function render(): void {
  const button = $('#broadcast');
  button.classList.toggle('primary', !broadcast);
  button.classList.toggle('danger', !!broadcast);
  // The ▾ tells the teacher they'll be asked which screen.
  button.classList.toggle('pick-screen', !broadcast && screens.length > 1);
  button.querySelector('span')!.textContent = broadcast ? 'Stop showing' : 'Show my screen';
  $('#banner').hidden = !broadcast;
  if (broadcast) $('#banner-text').textContent = `Showing your screen to ${broadcast.label}`;
  renderScreenTabs();
}

/** While showing, a tab per monitor switches what students see; hidden with one monitor. */
function renderScreenTabs(): void {
  const tabs = $('#banner-screens');
  const showing = broadcast?.displayId;
  tabs.hidden = !broadcast || screens.length < 2;
  tabs.replaceChildren(
    ...(tabs.hidden ? [] : screens).map((s, i) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: `Screen ${i + 1}` });
      button.title = `${s.label ? `${s.label} · ` : ''}${s.bounds.width}×${s.bounds.height}${s.primary ? ' (main screen)' : ''}`;
      button.dataset.display = s.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(s.id === showing));
      button.addEventListener('click', () => void switchScreen(s.id));
      return button;
    }),
  );
}
