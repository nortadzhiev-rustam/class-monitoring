// Periodic screen thumbnails for the teacher's grid. With several monitors the
// thumbnail shows all of them, laid out as arranged, so nothing escapes the
// teacher's view on a second screen.

import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';
import { blit, compositeLayout } from '../shared/displays';
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
  const image = screen.getAllDisplays().length > 1 ? await composite() : (await primaryScreenSource(config.width))?.thumbnail;
  if (!image || image.isEmpty()) return;
  const jpeg = image.toJPEG(60);
  // An unchanged screen is only resent every 10 s.
  if (lastThumb?.equals(jpeg) && Date.now() - lastThumbAt < 10_000) return;
  lastThumb = jpeg;
  lastThumbAt = Date.now();
  const { width, height } = image.getSize();
  send({ type: 'thumb', width, height }, jpeg);
}

/** Every monitor's picture drawn into one image at its place in the desktop arrangement. */
async function composite(): Promise<NativeImage> {
  const primary = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays().map((d) => ({ id: String(d.id), bounds: d.bounds, primary: d.id === primary }));
  const layout = compositeLayout(displays, config.width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: layout.width, height: layout.height } });
  const canvas = Buffer.alloc(layout.width * layout.height * 4); // gaps between screens stay black
  for (const rect of layout.rects) {
    const source = sources.find((s) => s.display_id === rect.id);
    if (!source || source.thumbnail.isEmpty()) continue;
    const scaled = source.thumbnail.resize({ width: rect.width, height: rect.height });
    const { width, height } = scaled.getSize(1);
    blit(canvas, layout.width, layout.height, scaled.toBitmap({ scaleFactor: 1 }), width, height, rect.x, rect.y);
  }
  return nativeImage.createFromBitmap(canvas, { width: layout.width, height: layout.height });
}

export function startThumbnails(): void {
  capture()
    .catch((err) => console.warn('[thumb]', (err as Error).message))
    .finally(() => setTimeout(startThumbnails, config.intervalMs));
}
