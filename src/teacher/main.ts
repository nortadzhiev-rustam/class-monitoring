import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureApp, shareScreenWithoutPicker } from '../shared/electron-setup';
import { pickFiles, pickSavePath } from '../shared/native-dialogs';
import { randomUUID } from 'node:crypto';
import { CONTROL_PORT, LIMITS, type InputEvent, type Platform, type Poll, type RtcSignal } from '../shared/protocol';
import { generateClassKey } from '../shared/secure-channel';
import { toCsv } from './csv';
import { TeacherFiles } from './files';
import type { ChatMessage, Group, Target, TeacherEvent, TeacherSettings, TeacherState } from './ipc';
import { Roster } from './roster';
import { ClassServer, type ServerConfig } from './server';

configureApp('Teacher');

if (!app.requestSingleInstanceLock()) app.exit(0);

let win: BrowserWindow | null = null;
let server: ClassServer;
let roster: Roster;
let files: TeacherFiles;
/** True while the teacher is remote-controlling a student. */
let controlling = false;
let quitting = false;
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
    groups: roster.groups(),
    platform: process.platform as Platform,
  };
}

/** The renderer is ours, but IPC arguments still get checked before they reach students. */
function asTarget(raw: Target): Target {
  const ids = Array.isArray(raw?.ids) ? raw.ids.filter((id) => typeof id === 'string').slice(0, 1000) : [];
  return { ids, everyone: raw?.everyone === true };
}

const lockText = (message: unknown) => String(message ?? '').slice(0, 200);
const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

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
  // Alt+F4 while controlling goes to the student, not the console, but a real
  // quit (logout, shutdown, Quit from the Dock) always goes through.
  win.on('close', (e) => {
    if (controlling && !quitting) e.preventDefault();
  });
  win.on('focus', () => win?.flashFrame(false));
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
    server.clearPolicy('broadcast');
    server.setPolicy(asTarget(target), { broadcast: String(sessionId) });
  });
  on('teacher:broadcast-stop', () => server.clearPolicy('broadcast'));
  handle('teacher:message', (target: Target, text: string) => {
    const body = clip(text, LIMITS.message);
    if (!body) throw new Error('Write a message first.');
    return server.sendTo(asTarget(target), { type: 'message', id: randomUUID(), text: body });
  });
  handle('teacher:chat', (id: string, text: string): ChatMessage => {
    const body = clip(text, LIMITS.chat);
    if (!body) throw new Error('Empty message.');
    const message: ChatMessage = { id: randomUUID(), from: 'teacher', text: body, at: Date.now() };
    if (!server.sendTo({ ids: [String(id)], everyone: false }, { type: 'chat', id: message.id, text: body, at: message.at })) {
      throw new Error('This student is offline.');
    }
    return message;
  });
  on('teacher:hand-clear', (id: string) => server.sendTo({ ids: [String(id)], everyone: false }, { type: 'hand-clear' }));
  handle('teacher:poll-start', (target: Target, question: string, choices: string[]): Poll => {
    const poll: Poll = {
      pollId: randomUUID(),
      question: clip(question, LIMITS.pollQuestion),
      choices: (Array.isArray(choices) ? choices : [])
        .map((c) => clip(c, LIMITS.pollChoice))
        .filter(Boolean)
        .slice(0, LIMITS.pollChoices),
    };
    if (!poll.question || poll.choices.length < 2) throw new Error('A poll needs a question and at least two answers.');
    server.clearPolicy('poll');
    server.setPolicy(asTarget(target), { poll });
    return poll;
  });
  on('teacher:poll-end', () => server.clearPolicy('poll'));
  handle('teacher:save-groups', (groups: Group[]) => roster.setGroups(groups));
  handle('teacher:register-start', (target: Target) => {
    const registerId = randomUUID();
    server.clearPolicy('register');
    server.setPolicy(asTarget(target), { register: registerId });
    return registerId;
  });
  on('teacher:register-end', () => server.clearPolicy('register'));
  handle('teacher:save-csv', async (defaultName: string, rows: string[][]) => {
    const file = await pickSavePath(win, path.join(app.getPath('documents'), clip(defaultName, 100) || 'export.csv'), [
      { name: 'Spreadsheet (CSV)', extensions: ['csv'] },
    ]);
    if (!file) return null;
    const clean = (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : []));
    fs.writeFileSync(file, toCsv(clean));
    return file;
  });
  handle('teacher:send-files', async (target: Target) => {
    const picked = await pickFiles(win, 'Choose files to send to students');
    if (!picked.length) return null;
    const { batchId, students } = files.send(asTarget(target), picked);
    return { batchId, files: picked.map((f) => path.basename(f)), students };
  });
  handle('teacher:collect-start', (target: Target, title: string) => {
    const collection = files.startCollect(clip(title, LIMITS.collectTitle));
    server.clearPolicy('collect');
    server.setPolicy(asTarget(target), { collect: { collectId: collection.collectId, title: collection.title } });
    return collection;
  });
  on('teacher:collect-end', () => {
    server.clearPolicy('collect');
    files.endCollect();
  });
  on('teacher:open-folder', (folder: string) => {
    if (files.owns(String(folder))) void shell.openPath(String(folder));
  });
  on('teacher:attention', (title: string, body?: string) => {
    // CM_QUIET keeps automated test runs from notifying whoever is at the computer.
    if (!win || win.isFocused() || process.env.CM_QUIET === '1') return;
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title: clip(title, 120), body: clip(body, 200) });
    notice.on('click', () => {
      win?.show();
      win?.focus();
    });
    notice.show();
  });
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
  files = new TeacherFiles(server, emit, process.env.CM_FILES_DIR ?? path.join(app.getPath('documents'), 'ClassMonitor'), (id) => {
    const entry = roster.get(id);
    return entry?.name || entry?.hostname || id;
  });
  server.on('left', (id) => {
    roster.left(id);
    files.left(id);
    emit({ type: 'left', id });
  });
  server.on('file', (id, msg, payload) => files.handle(id, msg, payload));
  server.on('sign-in', (id, registerId, name) => {
    roster.setName(id, name);
    emit({ type: 'sign-in', id, registerId, name });
  });
  server.on('policy', (id, policy) => emit({ type: 'policy', id, policy }));
  server.on('version-mismatch', (address) => emit({ type: 'version-mismatch', address }));
  server.on('chat', (id, { id: messageId, text, at }) => emit({ type: 'chat', id, message: { id: messageId, from: 'student', text, at } }));
  server.on('poll-answer', (id, pollId, choice) => emit({ type: 'poll-answer', id, pollId, choice }));
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
  quitting = true;
  server?.stop();
  roster?.flush();
});
