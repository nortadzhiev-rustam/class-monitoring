import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureApp, shareScreenWithoutPicker } from '../shared/electron-setup';
import { CONTROL_PORT, type InputEvent, type Platform, type RtcSignal } from '../shared/protocol';
import { generateClassKey } from '../shared/secure-channel';
import type { Target, TeacherEvent, TeacherSettings, TeacherState } from './ipc';
import { Roster } from './roster';
import { ClassServer, type ServerConfig } from './server';

configureApp('Teacher');

if (!app.requestSingleInstanceLock()) app.exit(0);

let win: BrowserWindow | null = null;
let server: ClassServer;
let roster: Roster;
/** True while the teacher is remote-controlling a student. */
let controlling = false;
let appMenu: Menu | null = null;

const settingsFile = () => path.join(app.getPath('userData'), 'teacher.json');

function loadConfig(): ServerConfig {
  let saved: Partial<ServerConfig> = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    // First run.
  }
  const config: ServerConfig = {
    room: process.env.CM_ROOM ?? saved.room ?? 'Classroom',
    teacherName: saved.teacherName ?? os.userInfo().username,
    classKey: process.env.CM_CLASS_KEY ?? saved.classKey ?? generateClassKey(),
    port: Number(process.env.CM_PORT ?? saved.port ?? CONTROL_PORT),
  };
  if (!saved.classKey && !process.env.CM_CLASS_KEY) saveConfig(config);
  return config;
}

function saveConfig(config: ServerConfig): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function state(): TeacherState {
  const { port, ...settings } = server.settings;
  return {
    settings,
    port,
    addresses: server.addresses(),
    students: server.list(),
    roster: roster.list(),
    platform: process.platform as Platform,
  };
}

/** The renderer is ours, but IPC arguments still get checked before they reach students. */
function asTarget(raw: Target): Target {
  const ids = Array.isArray(raw?.ids) ? raw.ids.filter((id) => typeof id === 'string').slice(0, 1000) : [];
  return { ids, everyone: raw?.everyone === true };
}

const lockText = (message: unknown) => String(message ?? '').slice(0, 200);

function emit(event: TeacherEvent): void {
  win?.webContents.send('teacher:event', event);
}

/**
 * While controlling, the page forwards every keystroke to the student. The app
 * menu is removed so its shortcuts (Cmd+W, Cmd+Q, ...) reach the page instead of
 * closing the console, and closing the window (Alt+F4) is ignored.
 */
function setControlling(enabled: boolean): void {
  if (controlling === enabled) return;
  controlling = enabled;
  if (process.platform === 'darwin') Menu.setApplicationMenu(enabled ? null : appMenu);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'ClassMonitor',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Keep broadcasting and remote view running while the console is minimised.
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (controlling) e.preventDefault();
  });
  win.on('closed', () => (win = null));

  void win.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc(): void {
  const fromWindow = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === win?.webContents;
  const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void) =>
    ipcMain.on(channel, (e, ...args) => fromWindow(e) && fn(...(args as A)));
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromWindow(e)) throw new Error('unknown sender');
      return fn(...(args as A));
    });

  handle('teacher:state', state);
  handle('teacher:generate-key', generateClassKey);
  handle('teacher:save-settings', async (s: TeacherSettings) => {
    const room = String(s.room).trim();
    const classKey = String(s.classKey).trim();
    if (!room || classKey.length < 8) throw new Error('Room name and a class key of at least 8 characters are required.');
    const config = { ...server.settings, room, classKey, teacherName: String(s.teacherName).trim() || os.userInfo().username };
    setControlling(false);
    await server.reconfigure(config);
    saveConfig(config);
    return state();
  });
  on('teacher:copy', (text: string) => clipboard.writeText(text));
  on('teacher:forget', (id: string) => roster.forget(id));
  on('teacher:lock', (target: Target, message: string) => server.setPolicy(asTarget(target), { lock: lockText(message) }));
  on('teacher:unlock', (target: Target) => server.setPolicy(asTarget(target), { lock: null }));
  on('teacher:view-start', (id: string, sessionId: string) => server.send(id, { type: 'view-start', sessionId }));
  on('teacher:view-stop', (id: string, sessionId: string) => server.send(id, { type: 'view-stop', sessionId }));
  on('teacher:control', (id: string, sessionId: string, enabled: boolean) => {
    setControlling(enabled);
    server.send(id, { type: 'control', sessionId, enabled, teacherPlatform: process.platform as Platform });
  });
  on('teacher:input', (id: string, sessionId: string, events: InputEvent[]) =>
    server.send(id, { type: 'input', sessionId, events }),
  );
  on('teacher:broadcast-start', (target: Target, sessionId: string) => {
    server.stopBroadcast();
    server.setPolicy(asTarget(target), { broadcast: String(sessionId) });
  });
  on('teacher:broadcast-stop', () => server.stopBroadcast());
  on('teacher:signal', (id: string, sessionId: string, signal: RtcSignal) =>
    server.send(id, { type: 'signal', sessionId, signal }),
  );
}

app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

app.whenReady().then(async () => {
  appMenu = Menu.getApplicationMenu();
  shareScreenWithoutPicker();
  roster = new Roster(path.join(app.getPath('userData'), 'roster.json'));
  server = new ClassServer(loadConfig());
  server.on('joined', (student) => emit({ type: 'joined', student, entry: roster.seen(student.info, student.address) }));
  server.on('left', (id) => {
    roster.left(id);
    emit({ type: 'left', id });
  });
  server.on('policy', (id, policy) => emit({ type: 'policy', id, policy }));
  server.on('version-mismatch', (address) => emit({ type: 'version-mismatch', address }));
  server.on('status', (id, status) => emit({ type: 'status', id, status }));
  server.on('thumb', (id, jpeg) => emit({ type: 'thumb', id, jpeg }));
  server.on('signal', (id, sessionId, signal) => emit({ type: 'signal', id, sessionId, signal }));
  server.on('broadcast-ready', (id, sessionId) => emit({ type: 'broadcast-ready', id, sessionId }));
  server.on('student-error', (id, sessionId, message) => emit({ type: 'student-error', id, sessionId, message }));

  try {
    await server.start();
  } catch (err) {
    dialog.showErrorBox(
      'ClassMonitor could not start',
      `Port ${server.settings.port} is unavailable (${(err as Error).message}). Is another teacher console running on this computer?`,
    );
    app.exit(1);
    return;
  }

  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  server?.stop();
  roster?.flush();
});
