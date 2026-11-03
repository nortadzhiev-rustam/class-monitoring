// Thin wrapper around RTCPeerConnection for one-way screen streams on a LAN.
// The side that owns the video track calls `offer()`; the other side answers.
// Signals are applied strictly in order, so ICE candidates never race ahead of
// the remote description.

import type { RtcSignal } from '../shared/protocol';

export class Peer {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly send: (signal: RtcSignal) => void) {
    this.pc.onicecandidate = (e) => send({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
  }

  /** Adds a screen track tuned for legible text rather than smooth motion. */
  addScreen(stream: MediaStream, maxBitrate: number): void {
    for (const track of stream.getVideoTracks()) {
      track.contentHint = 'detail';
      const sender = this.pc.addTrack(track, stream);
      const params = sender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      params.encodings = [{ maxBitrate }];
      void sender.setParameters(params).catch(() => {});
    }
  }

  async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.send({ kind: 'offer', sdp: this.pc.localDescription!.sdp });
  }

  handle(signal: RtcSignal): void {
    this.chain = this.chain
      .then(() => this.apply(signal))
      .catch((err) => console.error('[peer] signal failed', signal.kind, err));
  }

  close(): void {
    this.pc.close();
  }

  private async apply(signal: RtcSignal): Promise<void> {
    if (this.pc.signalingState === 'closed') return;
    switch (signal.kind) {
      case 'offer':
        await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.send({ kind: 'answer', sdp: this.pc.localDescription!.sdp });
        break;
      case 'answer':
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        break;
      case 'ice':
        if (signal.candidate) await this.pc.addIceCandidate(signal.candidate);
        break;
    }
  }
}
