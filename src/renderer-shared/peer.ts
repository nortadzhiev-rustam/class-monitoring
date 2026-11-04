// Thin wrapper around RTCPeerConnection for one-way screen streams on a LAN.
// The side that owns the video track calls `offer()`; the other side answers.
// Signals are applied strictly in order, so ICE candidates never race ahead of
// the remote description.

import type { RtcSignal } from '../shared/protocol';

/**
 * Offers H.264 ahead of VP8. Chromium encodes H.264 on the graphics chip's
 * media engine where there is one (VideoToolbox on Macs), while VP8 is always
 * software; with a stream per student that is the difference between a few
 * percent and a whole CPU core. Both sides run the same app, so H.264 is
 * always accepted; if it's missing the browser's default (VP8) is used.
 */
function preferH264(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return;
  try {
    transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => !h264.includes(c))]);
  } catch (err) {
    console.warn('[peer] keeping the default codec', err);
  }
}

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
      const transceiver = this.pc.getTransceivers().find((t) => t.sender === sender);
      if (transceiver) preferH264(transceiver);
    }
    this.setMaxBitrate(maxBitrate);
  }

  /** Caps the video this side sends; can be changed while streaming. */
  setMaxBitrate(maxBitrate: number): void {
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      if (params.encodings.length) for (const encoding of params.encodings) encoding.maxBitrate = maxBitrate;
      else params.encodings = [{ maxBitrate }];
      void sender.setParameters(params).catch((err) => console.warn('[peer] bitrate not applied', err));
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
