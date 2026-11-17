// Lock screen and the screen being shown to the class, one window per monitor.
// The primary display's window decodes the shown screen (the teacher's or a
// classmate's) and draws it; frames arrive over the encrypted link to the teacher.

import { ScreenDecoder } from '../../renderer-shared/screen-decoder';
import type { OverlayState, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const waiting = document.getElementById('waiting')!;
/** "Connecting to …'s screen", restored for each new broadcast. */
const connecting = [...waiting.childNodes].map((node) => node.cloneNode(true));

let sessionId: string | null = null;
let decoder: ScreenDecoder | null = null;

function render(state: OverlayState): void {
  const wanted = state.mode === 'broadcast' && state.primary ? state.sessionId : null;
  const fresh = wanted !== sessionId;
  if (fresh) {
    decoder?.close();
    decoder = null;
    sessionId = wanted;
    waiting.replaceChildren(...connecting.map((node) => node.cloneNode(true)));
    waiting.hidden = false;
  }

  document.body.dataset.mode = state.mode;
  document.body.dataset.primary = String(state.primary);
  document.getElementById('message')!.textContent = state.message || 'Your teacher has locked this screen.';
  for (const el of document.querySelectorAll('.teacher-name')) el.textContent = state.teacher;
  for (const el of document.querySelectorAll('.presenter-name')) el.textContent = state.presenter;

  if (!fresh || !wanted) return;
  const id = wanted;
  decoder = new ScreenDecoder(canvas, {
    // Asks the teacher's computer for a fresh keyframe.
    needKeyframe: () => api.broadcastReady(id),
    shown: () => (waiting.hidden = true),
    failed: () => {
      waiting.textContent = "This computer can't show this screen.";
      waiting.hidden = false;
    },
  });
  api.broadcastReady(id);
}

api.onOverlayState(render);
api.onBroadcastFrame((id, meta, data) => {
  if (id === sessionId) decoder?.push(meta, data);
});

// The overlay ignores typing, shortcuts and right-clicks.
for (const type of ['keydown', 'keyup', 'keypress', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => e.preventDefault(), true);
}

api.overlayReady();
