// Sends one encoded screen stream to everyone watching it, each over their own
// encrypted connection. A screen is encoded once (by the computer whose screen
// it is) and every viewer gets the same frames, so the work is the same for 3
// viewers or 30. (The console used to encode a separate WebRTC stream per
// student, and past about 15 the graphics chip's video encoder stalled them all.)
//
// The teacher's computer uses it to show a screen to the class; a student's
// computer uses it, with the teacher as the one viewer, to pace a remote view.
// A viewer whose connection backs up (slow Wi-Fi, a file transfer) skips frames
// until it has caught up and the next keyframe arrives, so one slow computer
// never holds back the rest.

import type { FrameMeta } from './protocol';

/** Sending to one viewer. */
export interface ViewerLink<M> {
  send(msg: M, payload: Buffer): void;
  /** Bytes queued on the connection, not yet sent. */
  buffered(): number;
  open(): boolean;
}

// Every viewer gets their own copy of a stream shown to the class, so the class
// shares one budget: up to 12 viewers get the full rate, a class of 30 about
// 1 Mbps each, and the sender's network link never carries more than ~30 Mbps.
// (Screen content usually needs far less than the cap.)
const CLASS_BUDGET = 30_000_000;
const MAX_PER_VIEWER = 2_500_000;
const MIN_PER_VIEWER = 500_000;

/** Bits per second for a stream that `viewers` computers each get a copy of. */
export const classBitrate = (viewers: number) =>
  Math.max(MIN_PER_VIEWER, Math.min(MAX_PER_VIEWER, Math.floor(CLASS_BUDGET / Math.max(1, viewers))));

/** Above this many queued bytes (~2 s of video) a viewer skips frames instead of falling further behind. */
export const MAX_QUEUED_BYTES = 512 * 1024;

export interface RelayEvents {
  /** Some student needs a keyframe to (re)start decoding. */
  keyframe(): void;
  /** How many students are watching changed. */
  viewers(count: number): void;
}

export class FrameRelay<M> {
  private sessionId: string | null = null;
  /** Viewers, and whether each must wait for a keyframe before it can decode again. */
  private readonly viewers = new Map<string, { needsKey: boolean }>();

  constructor(
    private readonly link: (id: string) => ViewerLink<M> | null,
    private readonly events: RelayEvents,
    /** The message that carries one frame of the session to a viewer. */
    private readonly message: (sessionId: string, meta: FrameMeta) => M,
  ) {}

  get session(): string | null {
    return this.sessionId;
  }

  get count(): number {
    return this.viewers.size;
  }

  start(sessionId: string): void {
    this.sessionId = sessionId;
    this.viewers.clear();
    this.events.viewers(0);
  }

  stop(): void {
    this.sessionId = null;
    this.viewers.clear();
  }

  /** A viewer is ready for the stream: first time, or again after a reload or a decoding error. */
  ready(id: string, sessionId: string): void {
    if (!this.sessionId || sessionId !== this.sessionId) return;
    const joined = !this.viewers.has(id);
    this.viewers.set(id, { needsKey: true });
    this.events.keyframe();
    if (joined) this.events.viewers(this.viewers.size);
  }

  left(id: string): void {
    if (this.viewers.delete(id)) this.events.viewers(this.viewers.size);
  }

  frame(sessionId: string, meta: FrameMeta, data: Buffer): void {
    if (!this.sessionId || sessionId !== this.sessionId) return;
    let wantKey = false;
    for (const [id, viewer] of this.viewers) {
      const link = this.link(id);
      if (!link?.open()) continue; // The server's 'left' event removes it.
      if (link.buffered() > MAX_QUEUED_BYTES) {
        // Behind: drop this frame, and every frame after it until a keyframe.
        viewer.needsKey = true;
        continue;
      }
      if (viewer.needsKey && !meta.key) {
        wantKey = true;
        continue;
      }
      link.send(this.message(sessionId, { codec: meta.codec, key: meta.key, timestamp: meta.timestamp }), data);
      viewer.needsKey = false;
    }
    if (wantKey) this.events.keyframe();
  }
}
