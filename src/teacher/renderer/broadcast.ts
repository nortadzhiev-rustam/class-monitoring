// "Show my screen": streams the teacher's screen to the targeted students.

import { Peer } from '../../renderer-shared/peer';
import type { RtcSignal } from '../../shared/protocol';
import { $, api, toast } from './dom';
import type { Resolved } from './targets';

const BROADCAST_BITRATE = 2_500_000;

let broadcast: { sessionId: string; stream: MediaStream; peers: Map<string, Peer>; label: string } | null = null;
let platform = '';

export function init(teacherPlatform: string): void {
  platform = teacherPlatform;
  $('#banner-stop').addEventListener('click', stop);
}

export const active = () => broadcast !== null;

export async function start(to: Resolved): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch (err) {
    toast(
      platform === 'darwin'
        ? 'Could not capture your screen. Allow Screen Recording for ClassMonitor Teacher in System Settings → Privacy & Security, then restart it.'
        : `Could not capture your screen: ${(err as Error).message}`,
    );
    return;
  }
  const sessionId = crypto.randomUUID();
  broadcast = { sessionId, stream, peers: new Map(), label: to.label };
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  api.broadcastStart(to.target, sessionId);
  render();
}

/** A student's display window is ready; send it the teacher's screen. */
export function connect(id: string, sessionId: string): void {
  if (!broadcast || broadcast.sessionId !== sessionId) return;
  broadcast.peers.get(id)?.close();
  const peer = new Peer((signal) => api.signal(id, sessionId, signal));
  peer.addScreen(broadcast.stream, BROADCAST_BITRATE);
  broadcast.peers.set(id, peer);
  peer.offer().catch((err) => console.error('[broadcast] offer failed', err));
}

export function handleSignal(id: string, sessionId: string, signal: RtcSignal): boolean {
  if (broadcast?.sessionId !== sessionId) return false;
  broadcast.peers.get(id)?.handle(signal);
  return true;
}

export function studentLeft(id: string): void {
  broadcast?.peers.get(id)?.close();
  broadcast?.peers.delete(id);
}

export function stop(): void {
  if (!broadcast) return;
  for (const peer of broadcast.peers.values()) peer.close();
  for (const track of broadcast.stream.getTracks()) track.stop();
  broadcast = null;
  api.broadcastStop();
  render();
}

function render(): void {
  const button = $('#broadcast');
  button.classList.toggle('primary', !broadcast);
  button.classList.toggle('danger', !!broadcast);
  button.querySelector('span')!.textContent = broadcast ? 'Stop showing' : 'Show my screen';
  $('#banner').hidden = !broadcast;
  if (broadcast) $('#banner-text').textContent = `Showing your screen to ${broadcast.label}`;
}
