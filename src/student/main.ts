import { randomUUID } from 'node:crypto';
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
  screen,
  shell,
  systemPreferences,
  Tray,
  type IpcMainEvent,
} from 'electron';
import { configureApp, primaryScreenSource, shareScreenWithoutPicker } from '../shared/electron-setup';
import type { Platform, RtcSignal, StudentInfo, TeacherMessage } from '../shared/protocol';
import { loadStudentConfig, systemConfigPath, type StudentConfig } from './config';
import { TeacherLink } from './connection';
import { INPUT_DRY_RUN, InputInjector } from './input';
import { Overlay } from './overlay';

configureApp('Student');

if (!app.requestSingleInstanceLock()) app.exit(0);

const canQuit = !app.isPackaged || process.env.CM_ALLOW_QUIT === '1';
const preload = path.join(__dirname, 'preload.js');

let config: StudentConfig | null = null;
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
  if (!config) return 'Not set up: no class key configured';
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
  if (!config) items.push({ label: `Config file: ${systemConfigPath()}`, enabled: false });
  if (canQuit) items.push({ type: 'separator' }, { label: 'Quit (development only)', click: () => app.exit(0) });

  tray.setToolTip(`ClassMonitor: ${statusLine()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
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
}

app.on('second-instance', () => tray?.popUpContextMenu());
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

  config = loadStudentConfig(app.getPath('userData'));
  if (config) {
    const id = studentId();
    link = new TeacherLink(config, () => studentInfo(id));
    link.on('message', onTeacherMessage);
    link.on('disconnected', resetSession);
    link.start();
    thumbnailLoop();
  } else {
    console.warn(`[student] no class key; create ${systemConfigPath()}`);
  }
  updateTray();
});
