// Hidden window that streams this computer's screen to the teacher's viewer.

import { Peer } from '../../renderer-shared/peer';
import type { StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const VIEW_BITRATE = 4_000_000;

const sessions = new Map<string, { peer: Peer; stream: MediaStream | null }>();

async function start(sessionId: string): Promise<void> {
  const session = { peer: new Peer((signal) => api.signal(sessionId, signal)), stream: null as MediaStream | null };
  sessions.set(sessionId, session);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 20 }, width: { max: 1920 }, height: { max: 1200 } },
      audio: false,
    });
    if (sessions.get(sessionId) !== session) {
      // The teacher closed the viewer while we were starting.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    session.stream = stream;
    session.peer.addScreen(stream, VIEW_BITRATE);
    await session.peer.offer();
  } catch (err) {
    stop(sessionId);
    api.viewError(sessionId, `Could not capture the screen: ${(err as Error).message}`);
  }
}

function stop(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.peer.close();
  session.stream?.getTracks().forEach((t) => t.stop());
}

api.onViewCommand((command) => {
  if (command.type === 'start') void start(command.sessionId);
  else stop(command.sessionId);
});

api.onSignal((sessionId, signal) => sessions.get(sessionId)?.peer.handle(signal));
