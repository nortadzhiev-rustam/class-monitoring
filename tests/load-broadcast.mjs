// Load test for "Show my screen": a teacher console and a classroom of student
// agents on this one computer, all watching the teacher's screen. Reports the
// frame rate each student shows and how responsive the console stays.
//
//   npm run build && node tests/load-broadcast.mjs [students=24] [seconds=10]
//
// Students decode in software, as each would on its own PC, so they don't
// compete with the teacher for this computer's video hardware. Their windows
// (and the console) open on screen while it runs, and their screens are what
// the teacher shows, so the picture keeps changing.

import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STUDENTS = Number(process.argv[2] ?? 24);
const SECONDS = Number(process.argv[3] ?? 10);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'class-monitor-load-'));
const base = {
  ...process.env,
  CM_CLASS_KEY: 'load-test-class-key',
  CM_ROOM: 'Load Room',
  CM_PORT: '47821',
  CM_TEACHER_HOST: '127.0.0.1',
  CM_OVERLAY_WINDOWED: '1',
  CM_QUIET: '1',
  CM_INPUT_DRY_RUN: '1',
  CM_LAUNCH_DRY_RUN: '1',
  CM_POWER_DRY_RUN: '1',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apps = [];
const gpuCrashes = [];

async function waitFor(predicate, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/** Frames the student has shown so far: the canvas counter, or a <video>'s for builds before the canvas. */
const framesShown = (overlay) =>
  overlay
    .evaluate(() => {
      const canvas = document.querySelector('#screen');
      if (canvas) return Number(canvas.dataset.frames ?? 0);
      return document.querySelector('#video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0;
    })
    .catch(() => 0);

async function primaryOverlay(app) {
  for (const p of app.windows().filter((w) => w.url().endsWith('overlay.html'))) {
    if ((await p.evaluate(() => document.body.dataset.primary).catch(() => null)) === 'true') return p;
  }
  return null;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (n) => Math.round(n * 10) / 10;

try {
  const teacher = await electron.launch({ args: ['dist/teacher/main.js'], env: { ...base, CM_USER_DATA: path.join(tmp, 'teacher') } });
  apps.push(teacher);
  teacher.process().stderr.on('data', (d) => /GPU process exited|GPU state invalid/.test(String(d)) && gpuCrashes.push(String(d).trim()));
  const page = await teacher.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

  console.log(`Show my screen to ${STUDENTS} students on this computer`);
  for (let i = 0; i < STUDENTS; i++) {
    const env = { ...base, CM_USER_DATA: path.join(tmp, `student-${i}`), CM_FILES_DIR: path.join(tmp, `student-${i}`, 'files') };
    apps.push(await electron.launch({ args: ['--disable-accelerated-video-decode', 'dist/student/main.js'], env }));
  }
  const students = apps.slice(1);
  const online = () => page.locator('.card:not(.offline)').count();
  if (!(await waitFor(async () => (await online()) === STUDENTS, 60_000))) throw new Error(`only ${await online()} of ${STUDENTS} students joined`);
  console.log(`  ${STUDENTS} students online`);

  // How long the console's page is blocked: the worst delay of a 100 ms timer.
  await page.evaluate(() => {
    window.loadLag = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      window.loadLag = Math.max(window.loadLag, now - last - 100);
      last = now;
    }, 100);
  });

  const asks = (await page.locator('#broadcast.pick-screen').count()) > 0;
  const started = Date.now();
  await page.click('#broadcast');
  if (asks) await page.click('.menu button >> nth=0');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

  // Time until each student shows the first picture.
  const overlays = await Promise.all(
    students.map(async (app) => {
      let overlay = null;
      await waitFor(async () => (overlay = await primaryOverlay(app)) !== null, 30_000);
      return overlay;
    }),
  );
  const firstFrame = await Promise.all(
    overlays.map(async (overlay) => (overlay && (await waitFor(async () => (await framesShown(overlay)) > 0, 30_000)) ? (Date.now() - started) / 1000 : null)),
  );

  await sleep(3000);
  await teacher.evaluate(({ app }) => app.getAppMetrics());
  await page.evaluate(() => (window.loadLag = 0));
  const before = await Promise.all(overlays.map((o) => (o ? framesShown(o) : 0)));
  await sleep(SECONDS * 1000);
  const after = await Promise.all(overlays.map((o) => (o ? framesShown(o) : 0)));
  const metrics = await teacher.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })));
  const lag = await page.evaluate(() => window.loadLag);
  const clickStart = Date.now();
  await page.click('#broadcast');
  const stopMs = Date.now() - clickStart;

  const fps = after.map((n, i) => (n - before[i]) / SECONDS);
  const shown = firstFrame.filter((t) => t !== null);
  const cpu = {};
  for (const m of metrics) cpu[m.type] = Math.round((cpu[m.type] ?? 0) + m.cpu);
  console.log(`  students showing the screen: ${shown.length} of ${STUDENTS}` + (shown.length ? `, first picture after ${round(Math.min(...shown))}–${round(Math.max(...shown))} s` : ''));
  console.log(`  frames per second per student: min ${round(Math.min(...fps))}, median ${round(median(fps))}, max ${round(Math.max(...fps))}; frozen (0 fps): ${fps.filter((f) => f === 0).length}`);
  console.log(`  teacher console: longest stall ${Math.round(lag)} ms, "Stop showing" took ${stopMs} ms, CPU ${JSON.stringify(cpu)} (% of one core)`);
  console.log(`  teacher graphics-process crashes: ${gpuCrashes.length}`);
  process.exitCode = shown.length === STUDENTS && fps.every((f) => f > 0) && gpuCrashes.length === 0 ? 0 : 1;
} finally {
  await Promise.all(apps.map((app) => app.close().catch(() => {})));
}
