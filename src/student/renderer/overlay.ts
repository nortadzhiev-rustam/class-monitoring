// Lock screen and teacher-screen display, one window per monitor.
// The primary display's window decodes the teacher's screen (WebCodecs) and
// draws it; frames arrive over the encrypted link to the teacher.

import type { BroadcastFrameMeta } from '../../shared/protocol';
import type { OverlayState, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const context = canvas.getContext('2d')!;
const waiting = document.getElementById('waiting')!;
/** "Connecting to …'s screen", restored for each new broadcast. */
const connecting = [...waiting.childNodes].map((node) => node.cloneNode(true));

/** Frames waiting to be decoded before this computer is considered too slow and skips to the next keyframe. */
const MAX_DECODE_QUEUE = 20;
/** Decoder failures in a row before giving up on this broadcast. */
const MAX_FAILURES = 5;

let sessionId: string | null = null;
let decoder: VideoDecoder | null = null;
let codec = '';
/** Delta frames can't be decoded until a keyframe has been. */
let needsKey = true;
let failures = 0;
let shown = 0;

function closeDecoder(): void {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  needsKey = true;
}

/** Starts again from the next keyframe, asking the teacher for one now. */
function restart(): void {
  closeDecoder();
  if (sessionId && failures < MAX_FAILURES) api.broadcastReady(sessionId);
}

function openDecoder(id: string, frameCodec: string): void {
  closeDecoder();
  codec = frameCodec;
  const current = new VideoDecoder({
    output: (frame) => {
      if (id === sessionId) draw(frame);
      frame.close();
    },
    error: (err) => {
      if (decoder !== current) return;
      console.warn('[overlay] decoder failed', err);
      decoder = null;
      needsKey = true;
      failures++;
      if (failures >= MAX_FAILURES) waiting.textContent = "This computer can't show your teacher's screen.";
      restart();
    },
  });
  current.configure({ codec, optimizeForLatency: true });
  decoder = current;
}

function draw(frame: VideoFrame): void {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  context.drawImage(frame, 0, 0);
  failures = 0;
  shown++;
  canvas.dataset.frames = String(shown);
  waiting.hidden = true;
}

function onFrame(id: string, meta: BroadcastFrameMeta, data: Uint8Array): void {
  if (id !== sessionId || failures >= MAX_FAILURES) return;
  if (!decoder || decoder.state === 'closed' || meta.codec !== codec) {
    if (!meta.key) return;
    openDecoder(id, meta.codec);
  }
  if (needsKey && !meta.key) return;
  // This computer can't keep up: drop the backlog and carry on from the next keyframe.
  if (decoder!.decodeQueueSize > MAX_DECODE_QUEUE) {
    restart();
    return;
  }
  try {
    decoder!.decode(new EncodedVideoChunk({ type: meta.key ? 'key' : 'delta', timestamp: meta.timestamp, data }));
    needsKey = false;
  } catch (err) {
    console.warn('[overlay] frame not decoded', err);
    restart();
  }
}

function render(state: OverlayState): void {
  const wanted = state.mode === 'broadcast' && state.primary ? state.sessionId : null;
  const fresh = wanted !== sessionId;
  if (fresh) {
    closeDecoder();
    sessionId = wanted;
    failures = 0;
    waiting.replaceChildren(...connecting.map((node) => node.cloneNode(true)));
    waiting.hidden = false;
  }

  document.body.dataset.mode = state.mode;
  document.body.dataset.primary = String(state.primary);
  document.getElementById('message')!.textContent = state.message || 'Your teacher has locked this screen.';
  for (const el of document.querySelectorAll('.teacher-name')) el.textContent = state.teacher;

  if (fresh && wanted) api.broadcastReady(wanted);
}

api.onOverlayState(render);
api.onBroadcastFrame(onFrame);

// The overlay ignores typing, shortcuts and right-clicks.
for (const type of ['keydown', 'keyup', 'keypress', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => e.preventDefault(), true);
}

api.overlayReady();
