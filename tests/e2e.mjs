// End-to-end check on one machine: starts a teacher console and a student agent,
// then exercises discovery, thumbnails, lock/unlock, remote view, remote control
// (dry run: the real mouse is never moved), broadcast, auth and disconnect safety.
//
// Overlays open as small windows (CM_OVERLAY_WINDOWED) so the test never takes
// over the screen. Screenshots go to tests/output/.

import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.resolve('tests/output');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'class-monitor-e2e-'));

const base = {
  ...process.env,
  CM_CLASS_KEY: 'e2e-test-class-key',
  CM_ROOM: 'E2E Room',
  CM_PORT: '47811',
  CM_OVERLAY_WINDOWED: '1',
  CM_INPUT_DRY_RUN: '1',
};

let failures = 0;
async function step(name, fn, { soft = false } = {}) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''} [${Date.now() - started} ms]`);
  } catch (err) {
    if (!soft) failures++;
    console.log(`  ${soft ? '!' : '✗'} ${name}: ${err.message.split('\n')[0]}`);
  }
}

const overlayPages = (app) => app.windows().filter((p) => p.url().endsWith('overlay.html'));
/** With several monitors only the primary display's overlay plays the broadcast. */
async function primaryOverlay(app) {
  for (const p of overlayPages(app)) {
    if ((await p.evaluate(() => document.body.dataset.primary).catch(() => null)) === 'true') return p;
  }
  return null;
}
async function waitFor(predicate, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

const teacher = await electron.launch({ args: ['dist/teacher/main.js'], env: { ...base, CM_USER_DATA: path.join(tmp, 'teacher') } });
const page = await teacher.firstWindow();
page.on('console', (m) => m.type() === 'error' && console.log('    [teacher console]', m.text()));
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

const student = await electron.launch({ args: ['dist/student/main.js'], env: { ...base, CM_USER_DATA: path.join(tmp, 'student') } });
const helperLog = [];
student.process().stdout.on('data', (d) => helperLog.push(String(d)));

console.log('ClassMonitor end-to-end');

await step('teacher shows the empty state', async () => {
  await page.waitForSelector('#empty:not([hidden])', { timeout: 10_000 });
  return await page.textContent('#empty-key');
});

await step('student is discovered over UDP and joins', async () => {
  await page.waitForSelector('.card', { timeout: 20_000 });
  return `${await page.textContent('.card .name')} · ${await page.textContent('.card .meta')}`;
});

await step(
  'thumbnail arrives',
  async () => {
    await page.waitForSelector('.card img[src^="blob:"]', { timeout: 15_000 });
    await page.screenshot({ path: path.join(out, '1-grid.png') });
  },
  { soft: true },
);

await step('lock all shows the message on the student', async () => {
  await page.click('#lock-all');
  await page.fill('#lock-message', 'Pens down, eyes up');
  await page.click('#lock-confirm');
  await page.waitForSelector('.card.locked', { timeout: 10_000 });
  let overlay = null;
  await waitFor(async () => (overlay = await primaryOverlay(student)) !== null);
  await overlay.waitForFunction(() => document.getElementById('message')?.textContent === 'Pens down, eyes up');
  await overlay.screenshot({ path: path.join(out, '2-lock-screen.png') });
  return `${overlayPages(student).length} overlay window(s)`;
});

await step('unlock all removes the lock screen', async () => {
  await page.click('#unlock-all');
  await page.waitForSelector('.card:not(.locked)', { timeout: 10_000 });
  await waitFor(async () => overlayPages(student).length === 0);
});

await step('remote view streams the student screen', async () => {
  await page.hover('.card .screen');
  await page.click('.card [data-action="view"]');
  await page.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 15_000 });
  const size = await page.evaluate(() => {
    const v = document.querySelector('#viewer-video');
    return `${v.videoWidth}×${v.videoHeight}`;
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '3-remote-view.png') });
  return size;
});

await step('remote control forwards mouse and keyboard (dry run)', async () => {
  await page.click('#viewer-control');
  await page.waitForSelector('.card.controlled', { state: 'attached', timeout: 10_000 });
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Shift+click then type: the student must see these in exactly this order.
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.press('KeyA');
  const expected = ['key 56 down', 'button 0 down', 'button 0 up', 'key 56 up', 'key 0 down', 'key 0 up'];
  const seen = () =>
    helperLog
      .join('')
      .split('\n')
      .map((l) => l.replace(/^.*\[input-helper\] /, ''))
      .filter((l) => /^(key|button)/.test(l))
      .map((l) => l.split(/ \d+ \d+| flags| clicks/)[0]);
  await waitFor(async () => seen().length >= expected.length).catch(() => {});
  if (seen().join(',') !== expected.join(',')) throw new Error(`helper saw ${seen().join(', ') || 'nothing'}`);
  await page.click('#viewer-control');
  await page.waitForSelector('.card:not(.controlled)', { state: 'attached', timeout: 10_000 });
  return 'Shift+click, then A, in order';
});

await step('closing the viewer ends the session', async () => {
  await page.click('#viewer-close');
  await page.waitForSelector('#viewer', { state: 'hidden' });
});

await step('broadcast shows the teacher screen on the student', async () => {
  await page.click('#broadcast');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });
  let overlay = null;
  await waitFor(async () => (overlay = await primaryOverlay(student)) !== null);
  await overlay.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 15_000 });
  await overlay.waitForTimeout(800);
  await overlay.screenshot({ path: path.join(out, '4-broadcast-on-student.png') });
  await page.click('#broadcast');
  await waitFor(async () => overlayPages(student).length === 0);
});

await step('a student with the wrong class key is refused', async () => {
  const intruder = await electron.launch({
    args: ['dist/student/main.js'],
    env: { ...base, CM_CLASS_KEY: 'wrong-key', CM_TEACHER_HOST: '127.0.0.1', CM_USER_DATA: path.join(tmp, 'intruder') },
  });
  await page.waitForTimeout(5000);
  const count = await page.locator('.card').count();
  await intruder.close();
  if (count !== 1) throw new Error(`expected 1 student, saw ${count}`);
});

await step('a student locked when the teacher disappears is unlocked', async () => {
  await page.click('#lock-all');
  await page.click('#lock-confirm');
  await waitFor(async () => overlayPages(student).length > 0);
  await teacher.close();
  await waitFor(async () => overlayPages(student).length === 0, 15_000);
});

await student.close();
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
console.log(`Screenshots: ${out}`);
process.exit(failures ? 1 : 0);
