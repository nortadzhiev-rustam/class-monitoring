// Shows an encoded screen stream on a canvas: frames from screen-encoder.ts
// (WebCodecs), or still JPEG pictures when a computer couldn't start video.
// Students use it for a screen shown to the class; the console for remote view.

import type { FrameMeta } from '../shared/protocol';

/** Frames waiting to be decoded before this computer is considered too slow and skips to the next keyframe. */
const MAX_DECODE_QUEUE = 20;
/** Decoding failures in a row before giving up on the stream. */
const MAX_FAILURES = 5;

export interface DecoderEvents {
  /** Decoding has to (re)start from a keyframe: ask the sender for one. */
  needKeyframe(): void;
  /** A picture was drawn; `count` is how many so far. */
  shown?(count: number): void;
  /** Decoding keeps failing on this computer. */
  failed?(): void;
}

export class ScreenDecoder {
  private decoder: VideoDecoder | null = null;
  private codec = '';
  /** Delta frames can't be decoded until a keyframe has been. */
  private needsKey = true;
  private failures = 0;
  private count = 0;
  private closed = false;
  /** Still pictures decode one after another, so they're drawn in order. */
  private stills: Promise<void> = Promise.resolve();
  private readonly context: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: DecoderEvents,
  ) {
    this.context = canvas.getContext('2d')!;
  }

  /** Pictures drawn so far. */
  get frames(): number {
    return this.count;
  }

  push(meta: FrameMeta, data: Uint8Array): void {
    if (this.closed || this.failures >= MAX_FAILURES) return;
    if (meta.codec === 'jpeg') {
      this.closeDecoder();
      this.codec = 'jpeg';
      this.drawStill(data);
      return;
    }
    if (!this.decoder || this.decoder.state === 'closed' || meta.codec !== this.codec) {
      if (!meta.key) return;
      this.open(meta.codec);
    }
    if (this.needsKey && !meta.key) return;
    // This computer can't keep up: drop the backlog and carry on from the next keyframe.
    if (this.decoder!.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.restart();
      return;
    }
    try {
      this.decoder!.decode(new EncodedVideoChunk({ type: meta.key ? 'key' : 'delta', timestamp: meta.timestamp, data }));
      this.needsKey = false;
    } catch (err) {
      console.warn('[screen] frame not decoded', err);
      this.restart();
    }
  }

  close(): void {
    this.closed = true;
    this.closeDecoder();
  }

  private open(codec: string): void {
    this.closeDecoder();
    this.codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!this.closed) this.draw(frame, frame.displayWidth, frame.displayHeight);
        frame.close();
      },
      error: (err) => {
        if (this.decoder !== decoder) return;
        console.warn('[screen] decoder failed', err);
        this.decoder = null;
        this.failures++;
        this.restart();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    this.decoder = decoder;
  }

  private drawStill(data: Uint8Array): void {
    this.stills = this.stills
      .then(async () => {
        if (this.closed) return;
        const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }));
        if (!this.closed) this.draw(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
      })
      .catch((err) => console.warn('[screen] picture not shown', err));
  }

  private draw(image: CanvasImageSource, width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.drawImage(image, 0, 0);
    this.failures = 0;
    this.count++;
    this.canvas.dataset.frames = String(this.count);
    this.events.shown?.(this.count);
  }

  /** Starts again from the next keyframe, asking the sender for one now. */
  private restart(): void {
    this.closeDecoder();
    if (this.failures < MAX_FAILURES) this.events.needKeyframe();
    else this.events.failed?.();
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.needsKey = true;
  }
}
