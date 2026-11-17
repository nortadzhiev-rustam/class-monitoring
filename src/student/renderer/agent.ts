// Hidden window that captures this computer's screen for the teacher's remote
// view and encodes it (WebCodecs, the same encoder the console uses to show the
// teacher's screen). Frames go to the main process, which sends them to the
// teacher over the encrypted link; see session.ts.

import { ScreenEncoder } from '../../renderer-shared/screen-encoder';
import type { StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
/** Remote view runs a little smoother than a screen shown to the class: it's one stream, and the teacher may be controlling. */
const FRAME_RATE = 20;
/** A capture that hasn't started by then is reported, and the main process falls back to still pictures. */
const CAPTURE_TIMEOUT_MS = 8000;

const sessions = new Map<string, { encoder: ScreenEncoder | null; stream: MediaStream | null }>();

/** Chromium's constraint for capturing one particular screen (the id comes from desktopCapturer). */
function screenConstraints(sourceId: string): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1200, maxFrameRate: FRAME_RATE };
  return { audio: false, video: { mandatory } as MediaTrackConstraints };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });
}

async function start(sessionId: string, sourceId: string, bitrate: number): Promise<void> {
  const session = { encoder: null as ScreenEncoder | null, stream: null as MediaStream | null };
  sessions.set(sessionId, session);
  try {
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia(screenConstraints(sourceId)), CAPTURE_TIMEOUT_MS, 'the screen capture did not start');
    if (sessions.get(sessionId) !== session) {
      // The teacher closed the viewer while we were starting.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('the screen capture has no picture');
    session.stream = stream;
    session.encoder = new ScreenEncoder(
      track,
      bitrate,
      ({ data, ...meta }) => api.viewFrame(sessionId, meta, data),
      (message) => fail(sessionId, message),
      FRAME_RATE,
    );
  } catch (err) {
    fail(sessionId, (err as Error).message);
  }
}

/** Live video isn't possible: tell the main process, which switches to still pictures. */
function fail(sessionId: string, message: string): void {
  if (!sessions.has(sessionId)) return;
  stop(sessionId);
  api.viewError(sessionId, message);
}

function stop(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.encoder?.close();
  session.stream?.getTracks().forEach((t) => t.stop());
}

api.onViewCommand((command) => {
  switch (command.type) {
    case 'start':
      void start(command.sessionId, command.sourceId, command.bitrate);
      break;
    case 'stop':
      stop(command.sessionId);
      break;
    case 'keyframe':
      sessions.get(command.sessionId)?.encoder?.requestKeyframe();
      break;
    case 'bitrate':
      sessions.get(command.sessionId)?.encoder?.setBitrate(command.bitrate);
      break;
  }
});
