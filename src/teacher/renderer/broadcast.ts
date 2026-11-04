// "Show my screen": streams the teacher's screen to the targeted students.

import { Peer } from '../../renderer-shared/peer';
import type { RtcSignal } from '../../shared/protocol';
import { $, api, toast } from './dom';
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

let broadcast: { sessionId: string; stream: MediaStream; peers: Map<string, Peer>; bitrate: number; label: string } | null = null;
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
  broadcast = { sessionId, stream, peers: new Map(), bitrate: perStudentBitrate(1), label: to.label };
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  api.broadcastStart(to.target, sessionId);
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
