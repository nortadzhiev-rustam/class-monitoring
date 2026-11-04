import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blit, compositeLayout, toDesktop, type DisplayInfo } from '../../src/shared/displays';

const laptop: DisplayInfo = { id: '1', primary: true, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
// A bigger monitor to the left of the laptop, top-aligned (negative x, as macOS and Windows report it).
const monitor: DisplayInfo = { id: '2', primary: false, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };

test('one display fills the thumbnail', () => {
  assert.deepEqual(compositeLayout([laptop], 480), { width: 480, height: 300, rects: [{ id: '1', x: 0, y: 0, width: 480, height: 300 }] });
});

test('two displays are laid out as arranged, scaled to the width', () => {
  const layout = compositeLayout([laptop, monitor], 672);
  // Desktop is 3360 x 1080 -> scale 0.2
  assert.equal(layout.height, 216);
  assert.deepEqual(layout.rects, [
    { id: '1', x: 384, y: 0, width: 288, height: 180 },
    { id: '2', x: 0, y: 0, width: 384, height: 216 },
  ]);
});

test('blit copies rows into place and clips at the edges', () => {
  const dest = Buffer.alloc(4 * 4 * 4); // 4x4 pixels
  const src = Buffer.alloc(3 * 2 * 4, 0xff); // 3x2 white
  blit(dest, 4, 4, src, 3, 2, 2, 3); // only 2x1 fits
  const white = (px: number, py: number) => dest[(py * 4 + px) * 4] === 0xff;
  assert.ok(white(2, 3) && white(3, 3));
  assert.ok(!white(1, 3) && !white(2, 2));
});

test('control points map onto the chosen display', () => {
  assert.deepEqual(toDesktop(monitor.bounds, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(toDesktop(monitor.bounds, 1, 1), { x: -1, y: 1079 });
  assert.deepEqual(toDesktop(laptop.bounds, 0.5, 0.5), { x: 719.5, y: 449.5 });
  assert.deepEqual(toDesktop(laptop.bounds, 7, Number.NaN), { x: 1439, y: 0 });
});
