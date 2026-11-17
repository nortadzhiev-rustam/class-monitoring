// "Show my screen": streams the teacher's screen to the targeted students.
// With several monitors the teacher picks one, and can switch while showing.
// The screen is encoded once here (screen-encoder.ts) and the main process
// sends the same frames to every student (broadcast-relay.ts).

import type { TeacherScreen } from '../ipc';
import { $, api, toast } from './dom';
import { showMenu } from './menu';
import { ScreenEncoder } from '../../renderer-shared/screen-encoder';
import { classBitrate } from '../../shared/frame-relay';
import type { Resolved } from './targets';


interface Broadcast {
  sessionId: string;
  stream: MediaStream;
  /** The monitor being shown. */
  displayId: string | undefined;
  encoder: ScreenEncoder;
  label: string;
}

/** Bit-rate changes wait for a burst of students joining to settle. */
const REBALANCE_MS = 1000;

let broadcast: Broadcast | null = null;
/** A student's screen being shown instead: from this remote-view session. */
let exhibit: { name: string; label: string; sessionId: string } | null = null;
let platform = '';
let screens: TeacherScreen[] = [];
/** Counts screen switches, so only the last of several quick clicks takes effect. */
let switches = 0;
let rebalanceTimer: number | null = null;

export function init(teacherPlatform: string, teacherScreens: TeacherScreen[]): void {
  platform = teacherPlatform;
  screens = teacherScreens;
  $('#banner-stop').addEventListener('click', () => (exhibit ? stopStudent() : stop()));
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
  else if (exhibit) stopStudent();
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
  stopStudent();
  const stream = await capture(displayId);
  const track = stream?.getVideoTracks()[0];
  if (!stream || !track) return;
  const sessionId = crypto.randomUUID();
  const encoder = new ScreenEncoder(
    track,
    classBitrate(1),
    ({ data, ...meta }) => api.broadcastFrame(sessionId, meta, data),
    (message) => {
      toast(message);
      stop();
    },
  );
  broadcast = { sessionId, stream, displayId: displayId ?? screens.find((s) => s.primary)?.id, encoder, label: to.label };
  track.addEventListener('ended', stop);
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
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopTracks(stream);
    return;
  }
  const old = session.stream;
  old.getVideoTracks()[0]?.removeEventListener('ended', stop);
  session.stream = stream;
  session.displayId = displayId;
  track.addEventListener('ended', stop);
  session.encoder.replaceTrack(track);
  stopTracks(old);
  render();
}

/** A student needs a keyframe to start (or restart) showing the screen. */
export function keyframe(): void {
  broadcast?.encoder.requestKeyframe();
}

/** Re-splits the class budget when students start or stop watching. */
export function viewers(count: number): void {
  if (rebalanceTimer !== null) clearTimeout(rebalanceTimer);
  rebalanceTimer = window.setTimeout(() => {
    rebalanceTimer = null;
    broadcast?.encoder.setBitrate(classBitrate(count));
  }, REBALANCE_MS);
}

export function stop(): void {
  if (!broadcast) return;
  broadcast.encoder.close();
  stopTracks(broadcast.stream);
  broadcast = null;
  api.broadcastStop();
  render();
}

/** Shows a student's screen (their open remote view) to the target instead of the teacher's. */
export function showStudent(to: Resolved, id: string, sessionId: string, name: string): void {
  stop();
  exhibit = { name, label: to.label, sessionId };
  api.exhibitStart(to.target, id, sessionId, name);
  render();
}

export function stopStudent(): void {
  if (!exhibit) return;
  exhibit = null;
  api.exhibitStop();
  render();
}

/** The console ended it (the student left). */
export function studentShowEnded(): void {
  exhibit = null;
  render();
}

/** The remote-view session currently shown to the class, if any. */
export const shownView = () => exhibit?.sessionId ?? null;

let onRender: () => void = () => {};
/** Called whenever what's shown to the class changes (the viewer's button follows). */
export function onChange(listener: () => void): void {
  onRender = listener;
}

function render(): void {
  const showing = broadcast !== null || exhibit !== null;
  const button = $('#broadcast');
  button.classList.toggle('primary', !showing);
  button.classList.toggle('danger', showing);
  // The ▾ tells the teacher they'll be asked which screen.
  button.classList.toggle('pick-screen', !showing && screens.length > 1);
  button.querySelector('span')!.textContent = showing ? 'Stop showing' : 'Show my screen';
  $('#banner').hidden = !showing;
  if (broadcast) $('#banner-text').textContent = `Showing your screen to ${broadcast.label}`;
  else if (exhibit) $('#banner-text').textContent = `Showing ${exhibit.name}'s screen to ${exhibit.label}`;
  renderScreenTabs();
  onRender();
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
