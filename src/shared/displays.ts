// Geometry for multi-monitor students: laying several screens out in one
// thumbnail, and turning a point on one screen into desktop coordinates.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  /** Matches desktopCapturer's display_id. */
  id: string;
  /** Position and size in device-independent pixels, as the OS arranges them. */
  bounds: Rect;
  primary: boolean;
}

export interface Layout {
  width: number;
  height: number;
  /** Where each display goes in the composite image, in output pixels. */
  rects: Array<{ id: string } & Rect>;
}

/** Scales the whole desktop arrangement to `width` pixels wide. */
export function compositeLayout(displays: DisplayInfo[], width: number): Layout {
  if (!displays.length) return { width, height: 0, rects: [] };
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const scale = width / (maxX - minX);
  return {
    width,
    height: Math.max(1, Math.round((maxY - minY) * scale)),
    rects: displays.map((d) => ({
      id: d.id,
      x: Math.round((d.bounds.x - minX) * scale),
      y: Math.round((d.bounds.y - minY) * scale),
      width: Math.max(1, Math.round(d.bounds.width * scale)),
      height: Math.max(1, Math.round(d.bounds.height * scale)),
    })),
  };
}

/** Copies a 4-bytes-per-pixel image into a larger one at (x, y), clipping at the edges. */
export function blit(dest: Buffer, destWidth: number, destHeight: number, src: Buffer, srcWidth: number, srcHeight: number, x: number, y: number): void {
  const rows = Math.min(srcHeight, destHeight - y);
  const cols = Math.min(srcWidth, destWidth - x);
  if (rows <= 0 || cols <= 0 || x < 0 || y < 0) return;
  for (let row = 0; row < rows; row++) {
    const from = row * srcWidth * 4;
    src.copy(dest, ((y + row) * destWidth + x) * 4, from, from + cols * 4);
  }
}

/** A point given as 0..1 across one display, in desktop coordinates. */
export function toDesktop(bounds: Rect, nx: number, ny: number): { x: number; y: number } {
  const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  return {
    x: bounds.x + clamp(nx) * (bounds.width - 1),
    y: bounds.y + clamp(ny) * (bounds.height - 1),
  };
}
