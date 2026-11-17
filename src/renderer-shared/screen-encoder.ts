// Encodes a captured screen once, with WebCodecs, for everyone watching it (the
// main process sends each frame on; see frame-relay.ts). The console uses it
// for the teacher's screen; a student's computer for its screen in remote view.
//
// H.264 is preferred because the graphics chip encodes it (VideoToolbox on Macs,
// Media Foundation on Windows), leaving the CPU free; VP8 in software is the
// fallback. Annex B output puts SPS/PPS in every keyframe, so a student can
// start decoding at any keyframe without any other setup.

import type { FrameMeta } from '../shared/protocol';

/** Hands out a track's frames one by one. Chromium has it in windows; TypeScript's DOM types don't include it. */
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

export interface EncodedFrame extends FrameMeta {
  data: Uint8Array;
}

/** H.264 High and Constrained Baseline at level 4.0 (up to 1920×1080), then VP8. */
const CODECS = ['avc1.640028', 'avc1.42E028', 'vp8'];
/** Keyframes are ~10× an ordinary frame; when several students ask at once, one per second serves them all. */
const MIN_KEYFRAME_INTERVAL_MS = 1000;
/** A still screen sends no new frames, so a student who joins then gets the last picture again, as a keyframe. */
const REFRESH_MS = 300;
/** Frames waiting in the encoder before new ones are dropped: keeps the picture live rather than late. */
const MAX_QUEUE = 2;
/** Encoder failures (e.g. the graphics process restarting) before falling back to software, and before giving up. */
const FAILURES_BEFORE_SOFTWARE = 2;
const FAILURES_BEFORE_GIVING_UP = 6;

/** H.264 needs even dimensions; the encoder scales each frame to the configured size. */
const even = (n: number) => Math.max(2, n & ~1);

export class ScreenEncoder {
  private reader: ReadableStreamDefaultReader<VideoFrame>;
  private encoder: VideoEncoder | null = null;
  private config: VideoEncoderConfig | null = null;
  /** A configuration is being chosen; frames meanwhile are dropped. */
  private configuring = false;
  private failures = 0;
  private closed = false;
  private keyWanted = true;
  private lastKeyAt = -Infinity;
  /** The latest captured picture, to re-encode as a keyframe while the screen is still. */
  private lastFrame: VideoFrame | null = null;
  private lastTimestamp = 0;
  private refreshTimer: number | null = null;

  constructor(
    track: MediaStreamTrack,
    private bitrate: number,
    private readonly output: (frame: EncodedFrame) => void,
    /** Encoding is impossible on this computer; the stream should stop. */
    private readonly failed: (message: string) => void,
    private readonly frameRate = 15,
  ) {
    this.reader = ScreenEncoder.read(track);
    void this.pump();
  }

  private static read(track: MediaStreamTrack): ReadableStreamDefaultReader<VideoFrame> {
    return new MediaStreamTrackProcessor({ track }).readable.getReader();
  }

  /** Another monitor is being shown; students get a keyframe of it straight away. */
  replaceTrack(track: MediaStreamTrack): void {
    const old = this.reader;
    this.reader = ScreenEncoder.read(track);
    void old.cancel().catch(() => {});
    this.keyWanted = true;
    this.lastKeyAt = -Infinity;
  }

  /** A student needs a keyframe to start showing the stream. */
  requestKeyframe(): void {
    this.keyWanted = true;
    this.scheduleRefresh();
  }

  /** Changes the bit rate (as students join or leave); takes effect without a new keyframe. */
  setBitrate(bitrate: number): void {
    if (bitrate === this.bitrate) return;
    this.bitrate = bitrate;
    if (this.encoder?.state === 'configured' && this.config) {
      this.config = { ...this.config, bitrate };
      this.encoder.configure(this.config);
    }
  }

  close(): void {
    this.closed = true;
    void this.reader.cancel().catch(() => {});
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.lastFrame?.close();
    this.lastFrame = null;
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      const reader = this.reader;
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        result = { done: true, value: undefined };
      }
      if (result.done) {
        if (reader === this.reader) return; // The capture ended; broadcast.ts stops on the track's 'ended'.
        continue; // Switched to another monitor's track.
      }
      const frame = result.value;
      if (this.closed || reader !== this.reader) {
        frame.close();
        continue;
      }
      this.lastFrame?.close();
      this.lastFrame = frame.clone();
      this.encode(frame);
    }
  }

  /** Encodes and closes `frame`. */
  private encode(frame: VideoFrame): void {
    const width = even(frame.displayWidth);
    const height = even(frame.displayHeight);
    if (!this.encoder || this.encoder.state === 'closed' || this.config?.width !== width || this.config?.height !== height) {
      frame.close();
      void this.configure(width, height);
      return;
    }
    // The encoder is behind (busy graphics chip): skip this picture; the next one replaces it.
    if (this.encoder.encodeQueueSize > MAX_QUEUE) {
      frame.close();
      return;
    }
    const now = performance.now();
    const key = this.keyWanted && now - this.lastKeyAt >= MIN_KEYFRAME_INTERVAL_MS;
    try {
      this.encoder.encode(frame, { keyFrame: key });
      this.lastTimestamp = frame.timestamp;
      if (key) {
        this.keyWanted = false;
        this.lastKeyAt = now;
      }
    } catch (err) {
      console.warn('[broadcast] frame not encoded', err);
    } finally {
      frame.close();
    }
    if (this.keyWanted) this.scheduleRefresh();
  }

  /** Re-encodes the last picture as a keyframe if no new one arrives soon (a still screen sends none). */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null || this.closed) return;
    const wait = Math.max(REFRESH_MS, this.lastKeyAt + MIN_KEYFRAME_INTERVAL_MS - performance.now());
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (!this.keyWanted || !this.lastFrame || this.closed) return;
      // Same picture, later timestamp: encoders expect time to move forward.
      this.encode(new VideoFrame(this.lastFrame, { timestamp: this.lastTimestamp + 1000 }));
    }, wait);
  }

  /** Picks the first supported codec (hardware first, until the hardware has failed) and sets up the encoder. */
  private async configure(width: number, height: number): Promise<void> {
    if (this.configuring || this.closed) return;
    this.configuring = true;
    try {
      const hardware = this.failures < FAILURES_BEFORE_SOFTWARE;
      let chosen: VideoEncoderConfig | null = null;
      for (const codec of CODECS) {
        for (const acceleration of hardware ? (['prefer-hardware', 'no-preference'] as const) : (['prefer-software'] as const)) {
          const config: VideoEncoderConfig = {
            codec,
            width,
            height,
            bitrate: this.bitrate,
            framerate: this.frameRate,
            latencyMode: 'realtime',
            hardwareAcceleration: acceleration,
            ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}),
          };
          const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
          if (support?.supported) {
            chosen = config;
            break;
          }
        }
        if (chosen) break;
      }
      if (this.closed) return;
      if (!chosen) {
        this.failed('This computer cannot encode video for screen sharing.');
        return;
      }
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
      const codec = chosen.codec;
      this.encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.output({ codec, key: chunk.type === 'key', timestamp: chunk.timestamp, data });
        },
        error: (err) => this.encoderFailed(err),
      });
      this.encoder.configure(chosen);
      this.config = chosen;
      // A new encoder's first frame is a keyframe; students need it to carry on.
      // The frame that prompted this was dropped, and a still screen may not send another.
      this.keyWanted = true;
      this.lastKeyAt = -Infinity;
      this.scheduleRefresh();
    } finally {
      this.configuring = false;
    }
  }

  /** The encoder broke (e.g. the graphics process restarted): the next frame sets up a new one. */
  private encoderFailed(err: DOMException): void {
    console.error('[broadcast] encoder failed', err);
    this.encoder = null;
    this.failures++;
    if (this.failures >= FAILURES_BEFORE_GIVING_UP && !this.closed) this.failed(`Screen sharing stopped: ${err.message}`);
  }
}
