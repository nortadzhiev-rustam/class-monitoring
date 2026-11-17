// "Show my screen" fan-out. The console window encodes the teacher's screen
// once; this sends the same encoded frames to every student watching, each over
// its own encrypted connection. The teacher's computer does the same work for 3
// students or 30. (It used to encode a separate WebRTC stream per student, and
// past about 15 students the graphics chip's video encoder stalled every stream.)
//
// A student whose connection backs up (slow Wi-Fi, a file transfer) skips frames
// until it has caught up and the next keyframe arrives, so one slow computer
// never holds back the rest of the class.

import type { BroadcastFrameMeta, TeacherMessage } from '../shared/protocol';

/** Sending to one connected student. */
export interface ViewerLink {
  send(msg: TeacherMessage, payload: Buffer): void;
  /** Bytes queued on the connection, not yet sent. */
  buffered(): number;
  open(): boolean;
}

/** Above this many queued bytes (~2 s of video) a student skips frames instead of falling further behind. */
export const MAX_QUEUED_BYTES = 512 * 1024;

export interface RelayEvents {
  /** Some student needs a keyframe to (re)start decoding. */
  keyframe(): void;
  /** How many students are watching changed. */
  viewers(count: number): void;
}

export class BroadcastRelay {
  private sessionId: string | null = null;
  /** Students watching, and whether each must wait for a keyframe before it can decode again. */
  private readonly viewers = new Map<string, { needsKey: boolean }>();

  constructor(
    private readonly link: (id: string) => ViewerLink | null,
    private readonly events: RelayEvents,
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

  /** A student's screen is ready to show the broadcast: first time, or again after a reload or a decoding error. */
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

  frame(sessionId: string, meta: BroadcastFrameMeta, data: Buffer): void {
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
      link.send({ type: 'broadcast-frame', sessionId, codec: meta.codec, key: meta.key, timestamp: meta.timestamp }, data);
      viewer.needsKey = false;
    }
    if (wantKey) this.events.keyframe();
  }
}
