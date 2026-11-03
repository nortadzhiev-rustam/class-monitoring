// Lock screen and teacher-screen display, one window per monitor.

import { Peer } from '../../renderer-shared/peer';
import type { OverlayState, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const video = document.getElementById('video') as HTMLVideoElement;
const waiting = document.getElementById('waiting')!;

let peer: Peer | null = null;
let sessionId: string | null = null;

function closePeer(): void {
  peer?.close();
  peer = null;
  sessionId = null;
  video.srcObject = null;
}

function render(state: OverlayState): void {
  document.body.dataset.mode = state.mode;
  document.body.dataset.primary = String(state.primary);
  document.getElementById('message')!.textContent = state.message || 'Your teacher has locked this screen.';
  for (const el of document.querySelectorAll('.teacher-name')) el.textContent = state.teacher;

  const wantsStream = state.mode === 'broadcast' && state.primary && state.sessionId;
  if (!wantsStream) {
    closePeer();
    return;
  }
  if (state.sessionId === sessionId) return;

  closePeer();
  const id = state.sessionId!;
  sessionId = id;
  waiting.hidden = false;
  peer = new Peer((signal) => api.signal(id, signal));
  peer.pc.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  video.onplaying = () => (waiting.hidden = true);
  api.broadcastReady(id);
}

api.onOverlayState(render);
api.onSignal((id, signal) => {
  if (id === sessionId) peer?.handle(signal);
});

// The overlay ignores typing, shortcuts and right-clicks.
for (const type of ['keydown', 'keyup', 'keypress', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => e.preventDefault(), true);
}

api.overlayReady();
