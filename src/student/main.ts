import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { configureApp, primaryScreenSource, shareScreenWithoutPicker } from '../shared/electron-setup';
import type { Platform, RtcSignal, StudentInfo, TeacherMessage } from '../shared/protocol';
import { isManagedConfig, loadStudentConfig, readUserConfig, saveUserConfig, type StudentConfig } from './config';
import { TeacherLink, watchBeacons } from './connection';
import { INPUT_DRY_RUN, InputInjector } from './input';
import type { DiscoveredClass, SetupDetails, SetupStatus } from './ipc';
import { Overlay } from './overlay';

configureApp('Student');

if (!app.requestSingleInstanceLock()) app.exit(0);

const canQuit = !app.isPackaged || process.env.CM_ALLOW_QUIT === '1';
const preload = path.join(__dirname, 'preload.js');

let config: StudentConfig | null = null;
/** IT supplies the key, so the student's own setup window is never offered. */
let managed = false;
/** The teacher refused our class key (it was mistyped or the teacher changed it). */
let keyRejected = false;
let link: TeacherLink | null = null;
let overlay: Overlay;
let agent: BrowserWindow | null = null;
let tray: Tray | null = null;
const injector = new InputInjector();

let teacher: { name: string; room: string } | null = null;
let thumbConfig = { intervalMs: 2000, width: 480 };
/** Open remote-view sessions; `control` holds the one allowed to send input. */
const viewSessions = new Set<string>();
let control: { sessionId: string; teacherPlatform: Platform } | null = null;

function studentId(): string {
  const file = path.join(app.getPath('userData'), 'student-id');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const id = randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id);
    return id;
  }
}

function studentInfo(id: string): StudentInfo {
  const { width, height } = screen.getPrimaryDisplay().size;
  return {
    id,
    hostname: config?.displayName ?? os.hostname(),
    username: os.userInfo().username,
    platform: process.platform as Platform,
    screen: { width, height },
    version: app.getVersion(),
  };
}

function sendStatus(): void {
  link?.send({ type: 'status', locked: overlay.locked, viewing: viewSessions.size > 0, controlled: control !== null });
  updateTray();
}

// ---------------------------------------------------------------- teacher commands

function onTeacherMessage(msg: TeacherMessage): void {
  switch (msg.type) {
    case 'welcome':
      teacher = { name: msg.teacher, room: msg.room };
      overlay.setTeacher(msg.teacher);
      sendStatus();
      break;
    case 'thumb-config':
      thumbConfig = {
        intervalMs: Math.max(500, Math.min(30_000, msg.intervalMs)),
        width: Math.max(160, Math.min(1280, msg.width)),
      };
      break;
    case 'lock':
      overlay.lock(msg.message || 'Your teacher has locked this screen.');
      sendStatus();
      break;
    case 'unlock':
      overlay.unlock();
      sendStatus();
      break;
    case 'broadcast-start':
      overlay.startBroadcast(msg.sessionId);
      break;
    case 'broadcast-stop':
      overlay.stopBroadcast(msg.sessionId);
      break;
    case 'view-start':
      viewSessions.add(msg.sessionId);
      agent?.webContents.send('student:view', { type: 'start', sessionId: msg.sessionId });
      sendStatus();
      break;
    case 'view-stop':
      endView(msg.sessionId);
      break;
    case 'control':
      setControl(msg.sessionId, msg.enabled, msg.teacherPlatform);
      break;
    case 'input':
      if (control && control.sessionId === msg.sessionId) injector.inject(msg.events, control.teacherPlatform);
      break;
    case 'signal':
      if (viewSessions.has(msg.sessionId)) agent?.webContents.send('student:signal', msg.sessionId, msg.signal);
      else overlay.sendSignal(msg.sessionId, msg.signal);
      break;
  }
}

function endView(sessionId: string): void {
  if (!viewSessions.delete(sessionId)) return;
  agent?.webContents.send('student:view', { type: 'stop', sessionId });
  if (control?.sessionId === sessionId) setControl(sessionId, false, control.teacherPlatform);
  sendStatus();
}

function setControl(sessionId: string, enabled: boolean, teacherPlatform: Platform): void {
  if (!enabled) {
    if (control?.sessionId === sessionId) {
      injector.stop();
      control = null;
      sendStatus();
    }
    return;
  }
  if (!viewSessions.has(sessionId)) return;
  if (process.platform === 'darwin' && !INPUT_DRY_RUN && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // Shows the system prompt once.
    link?.send({
      type: 'error',
      sessionId,
      message: 'Remote control needs Accessibility permission for ClassMonitor Student (System Settings → Privacy & Security → Accessibility).',
    });
    return;
  }
  try {
    injector.start();
  } catch (err) {
    link?.send({ type: 'error', sessionId, message: (err as Error).message });
    return;
  }
  control = { sessionId, teacherPlatform };
  sendStatus();
}

/** Drops everything the teacher had turned on, so a lost connection never leaves the student locked. */
function resetSession(): void {
  for (const sessionId of [...viewSessions]) endView(sessionId);
  overlay.clear();
  teacher = null;
  updateTray();
}

// ---------------------------------------------------------------- thumbnails

let lastThumb: Buffer | null = null;
let lastThumbAt = 0;

async function captureThumbnail(): Promise<void> {
  // Skip when the link is backed up (slow Wi-Fi) rather than queueing stale frames.
  if (!link?.connected || link.bufferedAmount > 1024 * 1024) return;
  const source = await primaryScreenSource(thumbConfig.width);
  if (!source || source.thumbnail.isEmpty()) return;
  const jpeg = source.thumbnail.toJPEG(60);
  // An unchanged screen is only resent every 10 s.
  if (lastThumb?.equals(jpeg) && Date.now() - lastThumbAt < 10_000) return;
  lastThumb = jpeg;
  lastThumbAt = Date.now();
  const { width, height } = source.thumbnail.getSize();
  link.send({ type: 'thumb', width, height }, jpeg);
}

function thumbnailLoop(): void {
  captureThumbnail()
    .catch((err) => console.warn('[thumb]', (err as Error).message))
    .finally(() => setTimeout(thumbnailLoop, thumbConfig.intervalMs));
}

// ---------------------------------------------------------------- tray

/** A ring with a centre dot, drawn at 32px for a 16pt (Retina) tray icon. */
function trayIcon(color: [number, number, number] | null): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = color ?? [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const ring = Math.min(1, Math.max(0, Math.min(d - 9.5, 13.5 - d) + 0.5));
      const dot = Math.min(1, Math.max(0, 5 - d + 0.5));
      const alpha = Math.round(255 * Math.max(ring, dot));
      const i = (y * size + x) * 4;
      buf[i] = Math.round((b * alpha) / 255); // BGRA, premultiplied
      buf[i + 1] = Math.round((g * alpha) / 255);
      buf[i + 2] = Math.round((r * alpha) / 255);
      buf[i + 3] = alpha;
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  if (!color) image.setTemplateImage(true);
  return image;
}

function statusLine(): string {
  if (!config) return 'Not set up yet: join a class to start';
  if (keyRejected) return `The teacher of ${config.room} didn't accept the class key`;
  if (!teacher) return `Looking for the teacher of ${config.room}…`;
  return `Connected to ${teacher.name} (${teacher.room})`;
}

function updateTray(): void {
  if (!tray) return;
  const connected = teacher !== null;
  if (process.platform !== 'darwin') tray.setImage(trayIcon(connected ? [31, 157, 85] : [138, 144, 155]));

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'ClassMonitor Student', enabled: false },
    { label: statusLine(), enabled: false },
  ];
  if (connected) items.push({ label: 'Your teacher can see this screen', enabled: false });
  if (viewSessions.size) items.push({ label: 'Your teacher is watching this screen now', enabled: false });
  if (control) items.push({ label: 'Your teacher is controlling this computer', enabled: false });
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    items.push({ type: 'separator' }, {
      label: 'Allow Screen Recording…',
      click: () => void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    });
  }
  if (canOfferSetup()) {
    const label = !config ? 'Join a class…' : keyRejected ? 'Fix the class key…' : 'Change class…';
    items.push({ type: 'separator' }, { label, click: openSetup });
  } else if (managed && keyRejected) {
    items.push({ label: 'Ask IT to update the class key on this computer', enabled: false });
  }
  if (canQuit) items.push({ type: 'separator' }, { label: 'Quit (development only)', click: () => app.exit(0) });

  tray.setToolTip(`ClassMonitor: ${statusLine()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------- teacher link

function startLink(next: StudentConfig): void {
  if (link) {
    link.removeAllListeners();
    link.stop();
    resetSession();
  }
  config = next;
  keyRejected = false;
  const id = studentId();
  link = new TeacherLink(next, () => studentInfo(id));
  link.on('message', onTeacherMessage);
  link.on('disconnected', resetSession);
  link.on('connected', ({ teacher: name, room }) => {
    keyRejected = false;
    confirmUserConfig();
    sendSetupStatus({ state: 'connected', teacher: name, room });
  });
  link.on('failed', (_message, rejected) => {
    if (!rejected) return;
    keyRejected = true;
    sendSetupStatus({ state: 'rejected' });
    updateTray();
  });
  link.start();
}

// ---------------------------------------------------------------- first-run setup
//
// Without an IT-deployed config the student joins a class themselves: pick a
// class heard on the network (or type a room name), enter the teacher's class
// key. Once a teacher has accepted the settings they're locked in, so students
// can't switch themselves out of a class; the window comes back only if the
// teacher later rejects the key.

let setup: BrowserWindow | null = null;
let setupBeacons: Socket | null = null;
let setupPrune: NodeJS.Timeout | null = null;
let setupWait: NodeJS.Timeout | null = null;
const discovered = new Map<string, DiscoveredClass & { seen: number }>();

function canOfferSetup(): boolean {
  if (managed) return false;
  return !config || keyRejected || !readUserConfig(app.getPath('userData')).confirmed;
}

function confirmUserConfig(): void {
  const dir = app.getPath('userData');
  const saved = readUserConfig(dir);
  if (managed || saved.confirmed || !saved.room || !saved.classKey) return;
  saveUserConfig(dir, { room: saved.room, classKey: saved.classKey, teacherHost: saved.teacherHost, confirmed: true });
}

function openSetup(): void {
  if (setup) {
    setup.show();
    setup.focus();
    return;
  }
  if (!canOfferSetup()) return;
  setup = new BrowserWindow({
    width: 440,
    height: 600,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Join your class',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f6f8',
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  setup.removeMenu();
  setup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setup.webContents.on('will-navigate', (e) => e.preventDefault());
  setup.webContents.on('did-finish-load', pushClasses);
  setup.once('ready-to-show', () => {
    setup?.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
  setup.on('closed', () => {
    setup = null;
    setupBeacons?.close();
    setupBeacons = null;
    for (const timer of [setupPrune, setupWait]) if (timer) clearTimeout(timer);
    setupPrune = setupWait = null;
    discovered.clear();
  });
  void setup.loadFile(path.join(__dirname, 'setup.html'));

  // List the classes whose teacher console is open on this network.
  setupBeacons = watchBeacons((beacon, host) => {
    const known = discovered.get(beacon.room);
    // Keep the first address seen; a teacher with several network interfaces beacons on each.
    discovered.set(beacon.room, { room: beacon.room, teacher: beacon.teacher, host: known?.host ?? host, seen: Date.now() });
    if (!known) pushClasses();
  });
  setupPrune = setInterval(() => {
    for (const [room, c] of discovered) if (Date.now() - c.seen > 7000) discovered.delete(room);
    pushClasses();
  }, 2000);
}

function pushClasses(): void {
  const classes = [...discovered.values()]
    .map(({ room, teacher: name, host }) => ({ room, teacher: name, host }))
    .sort((a, b) => a.room.localeCompare(b.room));
  setup?.webContents.send('student:setup-classes', classes);
}

function sendSetupStatus(status: SetupStatus): void {
  if (!setup) return;
  if (status.state !== 'connecting' && setupWait) {
    clearTimeout(setupWait);
    setupWait = null;
  }
  setup.webContents.send('student:setup-status', status);
  if (status.state === 'connected') setTimeout(() => setup?.close(), 1800);
}

function joinClass(details: SetupDetails): void {
  const room = String(details.room ?? '').trim() || 'Classroom';
  const classKey = String(details.classKey ?? '').trim();
  const teacherHost = String(details.teacherHost ?? '').trim() || undefined;
  if (classKey.length < 8) throw new Error('Enter the class key from your teacher.');
  if (room.length > 60) throw new Error('That room name is too long.');
  if (teacherHost && !/^[\w.:-]{1,253}$/.test(teacherHost)) throw new Error('That teacher address doesn\'t look right.');

  const dir = app.getPath('userData');
  saveUserConfig(dir, { room, classKey, teacherHost, confirmed: false });
  const next = loadStudentConfig(dir);
  if (!next) throw new Error('Could not save the settings.');
  startLink(next);
  updateTray();
  sendSetupStatus({ state: 'connecting', room });
  setupWait = setTimeout(() => {
    setupWait = null;
    if (!link?.connected && !keyRejected) sendSetupStatus({ state: 'waiting', room });
  }, 8000);
}

// ---------------------------------------------------------------- windows & IPC

function createAgentWindow(): void {
  agent = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  agent.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  agent.webContents.on('will-navigate', (e) => e.preventDefault());
  void agent.loadFile(path.join(__dirname, 'agent.html'));
}

function registerIpc(): void {
  const fromAgent = (e: IpcMainEvent) => e.sender === agent?.webContents;
  const fromOverlay = (e: IpcMainEvent) => overlay.owns(e.sender);

  ipcMain.on('student:signal', (e, sessionId: string, signal: RtcSignal) => {
    const allowed = fromAgent(e) ? viewSessions.has(sessionId) : fromOverlay(e) && sessionId === overlay.broadcastSession;
    if (allowed) link?.send({ type: 'signal', sessionId, signal });
  });
  ipcMain.on('student:view-error', (e, sessionId: string, message: string) => {
    if (!fromAgent(e)) return;
    link?.send({ type: 'error', sessionId, message });
    endView(sessionId);
  });
  ipcMain.on('student:overlay-ready', (e) => fromOverlay(e) && overlay.pushState(e.sender));
  ipcMain.on('student:broadcast-ready', (e, sessionId: string) => {
    if (fromOverlay(e) && sessionId === overlay.broadcastSession) link?.send({ type: 'broadcast-ready', sessionId });
  });

  const fromSetup = (e: IpcMainEvent | IpcMainInvokeEvent) => setup !== null && e.sender === setup.webContents;
  ipcMain.handle('student:setup-initial', (e) => {
    if (!fromSetup(e)) throw new Error('unknown sender');
    const saved = readUserConfig(app.getPath('userData'));
    return { room: saved.room ?? '', classKey: saved.classKey ?? '', teacherHost: saved.teacherHost ?? '', platform: process.platform };
  });
  ipcMain.handle('student:setup-join', (e, details: SetupDetails) => {
    if (!fromSetup(e) || managed) throw new Error('unknown sender');
    joinClass(details);
  });
  ipcMain.on('student:setup-close', (e) => fromSetup(e) && setup?.close());
}

app.on('second-instance', () => (canOfferSetup() ? openSetup() : tray?.popUpContextMenu()));
// No window to close and no menu: the agent runs until logout.
app.on('window-all-closed', () => {});
app.on('before-quit', (e) => {
  if (!canQuit) e.preventDefault();
});

app.whenReady().then(() => {
  app.dock?.hide();
  Menu.setApplicationMenu(null);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  shareScreenWithoutPicker();

  overlay = new Overlay(preload);
  tray = new Tray(trayIcon(process.platform === 'darwin' ? null : [138, 144, 155]));
  registerIpc();
  createAgentWindow();

  if (!app.isPackaged) {
    // Escape hatch while developing the lock screen.
    globalShortcut.register('CommandOrControl+Alt+Shift+U', () => overlay.clear());
  }

  managed = isManagedConfig();
  const saved = loadStudentConfig(app.getPath('userData'));
  if (saved) startLink(saved);
  else openSetup();
  thumbnailLoop();
  updateTray();
});
