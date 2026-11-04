// End-to-end check on one machine: starts a teacher console and student agents,
// then exercises discovery, thumbnails, lock/unlock, remote view, remote control
// (dry run: the real mouse is never moved), broadcast, auth, first-run setup,
// selection targeting, late joiners, offline cards and disconnect safety.
//
// Overlays open as small windows (CM_OVERLAY_WINDOWED) so the test never takes
// over the screen. Screenshots go to tests/output/.

import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import net from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronPath = createRequire(import.meta.url)('electron');
const out = path.resolve('tests/output');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'class-monitor-e2e-'));

// Files the native pickers "choose" during the run (see src/shared/native-dialogs.ts).
const worksheet = path.join(tmp, 'worksheet.bin');
writeFileSync(worksheet, randomBytes(700 * 1024)); // several 256 KB chunks
const essay = path.join(tmp, 'essay.txt');
writeFileSync(essay, 'My essay about the water cycle.\n');
const registerCsv = path.join(tmp, 'register.csv');

const base = {
  ...process.env,
  CM_CLASS_KEY: 'e2e-test-class-key',
  CM_ROOM: 'E2E Room',
  CM_PORT: '47811',
  CM_OVERLAY_WINDOWED: '1',
  CM_INPUT_DRY_RUN: '1',
  // No desktop notifications or Dock bouncing while the test runs.
  CM_QUIET: '1',
  // Log instead of opening the browser or restarting this computer.
  CM_LAUNCH_DRY_RUN: '1',
  CM_POWER_DRY_RUN: '1',
  CM_POWER_DELAY: '2',
  CM_WOL_PORT: '47899',
};

// Wake-on-LAN packets arrive here instead of waking anything.
const wolPackets = [];
const wolSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
wolSocket.on('message', (packet) => wolPackets.push(packet));
await new Promise((resolve) => wolSocket.bind(47899, resolve));

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

const pageOf = (app, file) => app.windows().find((p) => p.url().endsWith(file));
const overlayPages = (app) => app.windows().filter((p) => p.url().endsWith('overlay.html'));
/** With several monitors only the primary display's overlay plays the broadcast. */
async function primaryOverlay(app) {
  for (const p of overlayPages(app)) {
    if ((await p.evaluate(() => document.body.dataset.primary).catch(() => null)) === 'true') return p;
  }
  return null;
}
/** The id a student agent saved in its profile folder, to find its card. */
const idOf = (profile) => readFileSync(path.join(tmp, profile, 'student-id'), 'utf8').trim();
/** A freshly launched agent writes its id shortly after starting. */
const hasId = (profile) => existsSync(path.join(tmp, profile, 'student-id'));
const card = (profile) => `.card[data-id="${idOf(profile)}"]`;
const onlineCards = () => page.locator('.card:not(.offline)').count();
const studentEnv = (profile, extra = {}) => ({
  ...base,
  CM_USER_DATA: path.join(tmp, profile),
  CM_FILES_DIR: path.join(tmp, profile, 'files'),
  CM_TEST_OPEN: essay,
  ...extra,
});
const launchStudent = (profile, extra = {}) => electron.launch({ args: ['dist/student/main.js'], env: studentEnv(profile, extra) });

async function lockTarget(message) {
  await page.click('#lock');
  if (message) await page.fill('#lock-message', message);
  await page.click('#lock-confirm');
}

async function waitFor(predicate, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

const launchTeacher = () =>
  electron.launch({
    args: ['dist/teacher/main.js'],
    env: { ...base, CM_USER_DATA: path.join(tmp, 'teacher'), CM_FILES_DIR: path.join(tmp, 'teacher-files'), CM_TEST_OPEN: worksheet, CM_TEST_SAVE: registerCsv },
  });
let teacher = await launchTeacher();
let page = await teacher.firstWindow();
page.on('console', (m) => m.type() === 'error' && console.log('    [teacher console]', m.text()));
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

const student = await launchStudent('student');
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

await step('locking everyone shows the message on the student', async () => {
  await lockTarget('Pens down, eyes up');
  await page.waitForSelector('.card.locked', { timeout: 10_000 });
  let overlay = null;
  await waitFor(async () => (overlay = await primaryOverlay(student)) !== null);
  await overlay.waitForFunction(() => document.getElementById('message')?.textContent === 'Pens down, eyes up');
  await overlay.screenshot({ path: path.join(out, '2-lock-screen.png') });
  return `${overlayPages(student).length} overlay window(s)`;
});

await step('unlocking everyone removes the lock screen', async () => {
  await page.click('#unlock');
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

await step(
  'with two monitors: composite thumbnail, screen switcher, control on screen 2',
  async () => {
    const displays = await student.evaluate(({ screen }) =>
      screen.getAllDisplays().map((d) => ({ id: String(d.id), bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id })),
    );
    if (displays.length < 2) throw new Error(`skipped: this computer has ${displays.length} display`);
    await page.waitForSelector(`${card('student')} .pill:has-text("${displays.length} screens")`, { timeout: 10_000 });
    const second = displays.find((d) => !d.primary);
    await page.hover(`${card('student')} .screen`);
    await page.click(`${card('student')} [data-action="view"]`);
    await page.waitForSelector('#viewer-screens:not([hidden]) button', { timeout: 10_000 });
    await page.click(`#viewer-screens button[data-display="${second.id}"]`);
    await page.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 15_000 });
    await page.click('#viewer-control');
    helperLog.length = 0;
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await waitFor(async () => /move -?\d+ -?\d+/.test(helperLog.join('')));
    const [, x, y] = /move (-?\d+) (-?\d+)/.exec(helperLog.join(''));
    const b = second.bounds;
    if (!(x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height)) throw new Error(`pointer went to ${x},${y}, outside screen 2 (${JSON.stringify(b)})`);
    await page.screenshot({ path: path.join(out, '17-second-screen.png') });
    await page.click('#viewer-control');
    await page.click('#viewer-close');
    return `pointer at ${x},${y} on screen 2`;
  },
  { soft: true },
);

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

await step('a message pops up on the student', async () => {
  await page.click('#message');
  await page.fill('#message-text', 'Five minutes left');
  await page.click('#message-send');
  await page.waitForSelector('.toast.info:has-text("Message sent to 1 student")', { timeout: 5000 });
  let prompts = null;
  await waitFor(async () => (prompts = pageOf(student, 'prompts.html')));
  await prompts.waitForSelector('.card.message:has-text("Five minutes left")', { timeout: 10_000 });
  await prompts.screenshot({ path: path.join(out, '7-message-on-student.png') });
  await prompts.click('.card.message .btn');
  await prompts.waitForSelector('.card.message', { state: 'detached' });
});

await step('teacher and student chat both ways', async () => {
  await page.hover(`${card('student')} .screen`);
  await page.click(`${card('student')} [data-action="chat"]`);
  await page.fill('#chat-text', 'How is it going?');
  await page.press('#chat-text', 'Enter');
  let chat = null;
  await waitFor(async () => (chat = pageOf(student, 'chat.html')));
  await chat.waitForSelector('.line.teacher:has-text("How is it going?")', { timeout: 10_000 });
  await chat.fill('#text', 'Stuck on question 3');
  await chat.press('#text', 'Enter');
  await page.waitForSelector('#chat-lines .line.student:has-text("Stuck on question 3")', { timeout: 10_000 });
  await chat.screenshot({ path: path.join(out, '8-chat-on-student.png') });
});

await step('a raised hand reaches the help queue until the teacher clears it', async () => {
  const chat = pageOf(student, 'chat.html');
  await chat.click('#hand');
  await page.waitForSelector(`${card('student')} .pill.hand`, { timeout: 10_000 });
  await page.click('.tab[data-tab="help"]');
  await page.waitForSelector('#help-queue li', { timeout: 5000 });
  await pageOf(student, 'prompts.html').waitForSelector('.card.hand', { timeout: 5000 });
  await page.screenshot({ path: path.join(out, '9-help-queue.png') });
  await page.click('#help-queue li .btn.primary');
  await page.waitForSelector(`${card('student')} .pill.hand`, { state: 'detached', timeout: 10_000 });
  await chat.waitForFunction(() => document.getElementById('hand')?.textContent === 'Raise hand');
});

await step('a poll collects answers live', async () => {
  await page.click('#poll');
  await page.fill('#poll-text', 'Which answer is right?');
  await page.click('[data-preset="A|B|C|D"]');
  await page.click('#poll-form button[value="start"]');
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.poll:has-text("Which answer is right?")', { timeout: 10_000 });
  await prompts.click('.card.poll .choice:has-text("B")');
  await page.waitForSelector('#poll-count:has-text("1 of 1 student answered")', { timeout: 10_000 });
  await page.waitForSelector(`${card('student')} .pill.answer:has-text("B")`);
  await prompts.screenshot({ path: path.join(out, '10-poll-on-student.png') });
  await page.screenshot({ path: path.join(out, '11-poll-results.png') });
  await page.click('#poll-end');
  await prompts.waitForSelector('.card.poll', { state: 'detached', timeout: 10_000 });
  await page.waitForSelector('#poll-state:has-text("Poll ended")');
});

await step('the register collects names and exports a CSV', async () => {
  await page.click('#register');
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.sign-in input.name', { timeout: 10_000 });
  await prompts.fill('.card.sign-in input.name', 'Ada Lovelace');
  await prompts.click('.card.sign-in .btn.primary');
  await prompts.waitForSelector('.card.sign-in.done:has-text("Signed in as Ada Lovelace")');
  await page.waitForSelector('#register-count:has-text("1 of 1 student signed in")', { timeout: 10_000 });
  await page.waitForSelector(`${card('student')} .name:has-text("Ada Lovelace")`);
  await page.screenshot({ path: path.join(out, '12-register.png') });
  await page.click('#register-export');
  await page.waitForSelector('.toast.info:has-text("Register saved")', { timeout: 5000 });
  const csv = readFileSync(registerCsv, 'utf8');
  if (!/Ada Lovelace,MacBook|Ada Lovelace,.*Present/.test(csv)) throw new Error(`CSV is missing the row:\n${csv}`);
  await page.click('#register-end');
  return csv.split('\r\n')[1];
});

await step('files handed out arrive byte-identical', async () => {
  await page.click('#files');
  await page.click('.menu button:has-text("Send files")');
  await page.waitForSelector('#batches li:has-text("Delivered to 1 student")', { timeout: 15_000 });
  const received = path.join(tmp, 'student', 'files', 'From teacher', 'worksheet.bin');
  if (!readFileSync(received).equals(readFileSync(worksheet))) throw new Error('the received file differs');
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.file:has-text("worksheet.bin")');
  await prompts.screenshot({ path: path.join(out, '13-file-on-student.png') });
  await prompts.click('.card.file .btn:has-text("Done")');
  return '700 KB';
});

await step('collected work lands in the teacher\'s folder', async () => {
  await page.click('#files');
  await page.click('.menu button:has-text("Collect work")');
  await page.fill('#text-input', 'Essay draft');
  await page.click('#text-ok');
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.collect:has-text("Essay draft")', { timeout: 10_000 });
  await prompts.click('.card.collect .btn.primary');
  await prompts.waitForSelector('.card.collect li.ok:has-text("essay.txt")', { timeout: 10_000 });
  await page.waitForSelector('#collect-count:has-text("1 of 1 student handed in")', { timeout: 10_000 });
  await page.screenshot({ path: path.join(out, '14-collecting.png') });
  const collected = path.join(tmp, 'teacher-files', 'Collected');
  const folder = readdirSync(collected).find((f) => f.startsWith('Essay draft'));
  const file = path.join(collected, folder, 'Ada Lovelace', 'essay.txt');
  if (readFileSync(file, 'utf8') !== readFileSync(essay, 'utf8')) throw new Error('the collected file differs');
  await page.click('#collect-end');
  await prompts.waitForSelector('.card.collect', { state: 'detached', timeout: 10_000 });
  return path.relative(tmp, file);
});

const studentLog = () => helperLog.join('');

await step('opening a website and an app reaches the student (dry run)', async () => {
  await page.click('#open');
  await page.click('.menu button:has-text("Website")');
  await page.fill('#text-input', 'example.org');
  await page.click('#text-ok');
  await page.waitForSelector('.toast.info:has-text("Opened https://example.org on 1 computer")', { timeout: 5000 });
  await waitFor(async () => studentLog().includes('[launch] url https://example.org/'));
  await page.click('#open');
  await page.click('.menu button:has-text("App")');
  await page.fill('#text-input', 'Calculator');
  await page.click('#text-ok');
  await waitFor(async () => studentLog().includes('[launch] app Calculator'));
});

await step('a blocked app is closed on the student', async () => {
  const program = path.join(tmp, 'cmblockme');
  copyFileSync('/bin/sleep', program);
  chmodSync(program, 0o755);
  const running = spawn(program, ['300'], { stdio: 'ignore' });
  let exited = false;
  running.on('exit', () => (exited = true));
  await page.click('#apps');
  await page.fill('#apps-list', 'cmblockme');
  await page.click('#apps-on');
  await waitFor(async () => exited, 15_000).catch(() => {
    running.kill();
    throw new Error('the blocked program kept running');
  });
  await page.waitForSelector(`${card('student')} .pill:has-text("Apps blocked")`);
  await page.waitForSelector('.toast.info:has-text("tried to open cmblockme")', { timeout: 10_000 });
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.notice:has-text("cmblockme is blocked")');
  await prompts.screenshot({ path: path.join(out, '15-app-blocked.png') });
  await prompts.click('.card.notice .btn');
  await page.click('#apps');
  await page.click('#apps-off');
  await page.waitForSelector(`${card('student')} .pill:has-text("Apps blocked")`, { state: 'detached', timeout: 10_000 });
});

await step('power controls warn the student first (dry run)', async () => {
  await page.click('#power');
  await page.click('.menu button:has-text("Restart")');
  await page.click('#confirm-ok');
  const prompts = pageOf(student, 'prompts.html');
  await prompts.waitForSelector('.card.power .countdown', { timeout: 10_000 });
  await prompts.waitForTimeout(400); // let the window grow to fit the card
  await prompts.screenshot({ path: path.join(out, '16-power-warning.png') });
  await waitFor(async () => studentLog().includes('[power] restart (dry run)'), 10_000);
  await prompts.waitForSelector('.card.power', { state: 'detached' });
});

await step('the web filter bridge refuses programs without the secret', async () => {
  // Same socket name the student app derives from its profile folder (see native-host.ts).
  const tag = createHash('sha256').update(path.join(tmp, 'student')).digest('hex').slice(0, 12);
  const socket = net.connect(path.join(os.tmpdir(), `classmonitor-web-${tag}.sock`));
  let data = '';
  socket.on('data', (d) => (data += d));
  socket.on('error', () => {});
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write(`${JSON.stringify({ type: 'auth', secret: 'f'.repeat(64) })}\n`);
  await new Promise((resolve, reject) => {
    socket.on('close', resolve);
    setTimeout(() => reject(new Error('the bridge kept an unauthenticated connection open')), 7000);
  });
  if (data) throw new Error(`the bridge answered without the secret: ${data}`);
});

await step('the web filter bridge carries rules down and the site up (simulated browser)', async () => {
  // Start the student app the way Chrome does for the extension, and speak native messaging to it.
  const host = spawn(electronPath, ['dist/student/main.js', 'chrome-extension://lhfcpffeneandjbmhgdgdoajgcloccih/'], {
    env: studentEnv('student'),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const fromAgent = [];
  let pending = Buffer.alloc(0);
  host.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const length = pending.readUInt32LE(0);
      fromAgent.push(JSON.parse(pending.subarray(4, 4 + length).toString('utf8')));
      pending = pending.subarray(4 + length);
    }
  });
  const toAgent = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([header, body]));
  };
  const rulesFor = (domain) => fromAgent.some((m) => m.type === 'rules' && m.rules?.domains?.includes(domain));
  try {
    await waitFor(async () => fromAgent.some((m) => m.type === 'rules'), 15_000);
    toAgent({ type: 'hello', version: '0.1.0' });
    toAgent({ type: 'tab', url: 'https://www.example.org/page', title: 'Example Domain' });
    await page.waitForSelector(`${card('student')} .pill:has-text("example.org")`, { timeout: 10_000 });

    await page.click('#web');
    await page.fill('#web-list', 'https://www.youtube.com/watch?v=1');
    // Leave the tester's own Safari/Firefox alone: this agent runs on their Mac.
    await page.uncheck('#web-close-others');
    await page.click('#web-on');
    await waitFor(async () => rulesFor('youtube.com'));
    await page.waitForSelector(`${card('student')} .pill:has-text("Web rules on")`);
    await page.screenshot({ path: path.join(out, '18-web-rules.png') });

    await page.click('#web');
    await page.click('#web-off');
    await waitFor(async () => fromAgent.at(-1)?.type === 'rules' && fromAgent.at(-1).rules === null);
  } finally {
    host.kill();
  }
  // Extension gone: the site disappears from the card.
  await page.waitForSelector(`${card('student')} .pill:has-text("example.org")`, { state: 'detached', timeout: 10_000 });
  return `${fromAgent.length} messages from the agent`;
});

await step('a student with the wrong class key is refused', async () => {
  const intruder = await launchStudent('intruder', { CM_CLASS_KEY: 'wrong-key', CM_TEACHER_HOST: '127.0.0.1' });
  await page.waitForTimeout(5000);
  const count = await onlineCards();
  await intruder.close();
  if (count !== 1) throw new Error(`expected 1 student, saw ${count}`);
});

let newcomer = null;
const newcomerEnv = studentEnv('newcomer');
await step('a new student joins through the setup window', async () => {
  const env = newcomerEnv;
  delete env.CM_CLASS_KEY;
  delete env.CM_ROOM;
  const setupPage = (app) => app.windows().find((p) => p.url().endsWith('setup.html'));

  newcomer = await electron.launch({ args: ['dist/student/main.js'], env });
  await waitFor(async () => setupPage(newcomer));
  const setup = setupPage(newcomer);
  await setup.waitForSelector('.option:has-text("E2E Room")', { timeout: 10_000 });

  await setup.fill('#key', 'NOT-THE-RIGHT-KEY');
  await setup.click('#join');
  await setup.waitForSelector('#status.error', { timeout: 15_000 });

  // Keys are case-insensitive: the teacher's key is "e2e-test-class-key".
  await setup.fill('#key', 'E2E-Test-Class-Key');
  await setup.screenshot({ path: path.join(out, '5-setup-window.png') });
  await setup.click('#join');
  await setup.waitForSelector('#status.ok', { timeout: 15_000 });
  await waitFor(async () => (await onlineCards()) === 2);
  await waitFor(async () => !setupPage(newcomer));
  await newcomer.close();
  await waitFor(async () => (await onlineCards()) === 1);

  // Restarted, it rejoins from the saved settings without asking again.
  newcomer = await electron.launch({ args: ['dist/student/main.js'], env });
  await waitFor(async () => (await onlineCards()) === 2, 15_000);
  if (setupPage(newcomer)) throw new Error('setup window reopened after a successful join');
});

await step('locking selected students leaves the others alone', async () => {
  await page.hover(`${card('newcomer')} .screen`);
  await page.click(`${card('newcomer')} .select`);
  const target = await page.textContent('#target-text');
  if (target !== '1 selected student') throw new Error(`target says "${target}"`);
  await lockTarget('Just you');
  await page.waitForSelector(`${card('newcomer')}.locked`, { timeout: 10_000 });
  await waitFor(async () => overlayPages(newcomer).length > 0);
  if (overlayPages(student).length) throw new Error('the unselected student was locked too');
  await page.click('#select-none');
  await page.click('#unlock');
  await waitFor(async () => overlayPages(newcomer).length === 0);
  return target;
});

await step('a group lock reaches only that group, also after a reconnect', async () => {
  await page.hover(`${card('newcomer')} .screen`);
  await page.click(`${card('newcomer')} .select`);
  await page.click('.view-chip.add');
  await page.fill('#text-input', 'Table 1');
  await page.click('#text-ok');
  await page.waitForSelector('.view-chip.active:has-text("Table 1")');
  await page.waitForSelector(card('student'), { state: 'detached' });
  const target = await page.textContent('#target-text');
  if (target !== 'Table 1') throw new Error(`target says "${target}"`);
  await lockTarget('Group work');
  await waitFor(async () => overlayPages(newcomer).length > 0);
  if (overlayPages(student).length) throw new Error('a student outside the group was locked');

  await newcomer.close();
  newcomer = await electron.launch({ args: ['dist/student/main.js'], env: newcomerEnv });
  await page.waitForSelector(`${card('newcomer')}.locked`, { timeout: 20_000 });
  await page.click('#unlock');
  await waitFor(async () => overlayPages(newcomer).length === 0);
  await page.click('.view-chip:has-text("All students")');
  return target;
});

await step('a student who joins late gets the class lock', async () => {
  await lockTarget('Late again');
  const late = await launchStudent('late');
  await waitFor(async () => hasId('late'));
  await page.waitForSelector(`${card('late')}.locked`, { timeout: 20_000 });
  let overlay = null;
  await waitFor(async () => (overlay = await primaryOverlay(late)) !== null);
  await overlay.waitForFunction(() => document.getElementById('message')?.textContent === 'Late again');
  await page.click('#unlock');
  await waitFor(async () => overlayPages(late).length === 0 && overlayPages(student).length === 0);
  await late.close();
});

await step('disconnected students stay as offline cards until forgotten', async () => {
  await newcomer.close();
  await page.waitForSelector(`${card('newcomer')}.offline`, { timeout: 10_000 });
  const placeholder = await page.textContent(`${card('newcomer')} .placeholder`);
  await page.screenshot({ path: path.join(out, '6-offline-cards.png') });
  await page.hover(`${card('newcomer')} .screen`);
  await page.click(`${card('newcomer')} [data-action="wake"]`);
  await waitFor(async () => wolPackets.some((p) => p.length === 102 && p.subarray(0, 6).every((b) => b === 0xff)), 5000).catch(() => {
    throw new Error('no Wake-on-LAN packet arrived');
  });
  await page.click('#show-offline');
  await page.waitForSelector(card('newcomer'), { state: 'detached' });
  await page.click('#show-offline');
  await page.hover(`${card('late')} .screen`);
  await page.click(`${card('late')} [data-action="forget"]`);
  await page.waitForSelector(card('late'), { state: 'detached' });
  return placeholder;
});

await step('a student locked when the teacher disappears is unlocked', async () => {
  await lockTarget();
  await waitFor(async () => overlayPages(student).length > 0);
  await teacher.close();
  await waitFor(async () => overlayPages(student).length === 0, 15_000);
});

await step('the roster survives a teacher restart', async () => {
  teacher = await launchTeacher();
  page = await teacher.firstWindow();
  await page.waitForSelector(`${card('newcomer')}.offline`, { timeout: 10_000 });
  await page.waitForSelector(`${card('student')}:not(.offline)`, { timeout: 20_000 });
  if (await page.locator(card('late')).count()) throw new Error('a forgotten student came back');
  await page.waitForSelector('.view-chip:has-text("Table 1")', { timeout: 5000 });
  await page.waitForSelector(`${card('student')} .name:has-text("Ada Lovelace")`);
  await teacher.close();
});

await student.close();
wolSocket.close();
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
console.log(`Screenshots: ${out}`);
process.exit(failures ? 1 : 0);
