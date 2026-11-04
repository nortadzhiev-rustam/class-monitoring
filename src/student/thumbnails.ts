// Periodic screen thumbnails for the teacher's grid.

import { primaryScreenSource } from '../shared/electron-setup';
import { send, state } from './state';

let config = { intervalMs: 2000, width: 480 };
let lastThumb: Buffer | null = null;
let lastThumbAt = 0;

/** The teacher decides how often and how large; clamp to sane limits. */
export function configure(intervalMs: number, width: number): void {
  config = {
    intervalMs: Math.max(500, Math.min(30_000, intervalMs)),
    width: Math.max(160, Math.min(1280, width)),
  };
}

async function capture(): Promise<void> {
  const link = state.link;
  // Skip when the link is backed up (slow Wi-Fi) rather than queueing stale frames.
  if (!link?.connected || link.bufferedAmount > 1024 * 1024) return;
  const source = await primaryScreenSource(config.width);
  if (!source || source.thumbnail.isEmpty()) return;
  const jpeg = source.thumbnail.toJPEG(60);
  // An unchanged screen is only resent every 10 s.
  if (lastThumb?.equals(jpeg) && Date.now() - lastThumbAt < 10_000) return;
  lastThumb = jpeg;
  lastThumbAt = Date.now();
  const { width, height } = source.thumbnail.getSize();
  send({ type: 'thumb', width, height }, jpeg);
}

export function startThumbnails(): void {
  capture()
    .catch((err) => console.warn('[thumb]', (err as Error).message))
    .finally(() => setTimeout(startThumbnails, config.intervalMs));
}
