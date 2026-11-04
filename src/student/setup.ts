// First-run "Join your class" window.
//
// Without an IT-deployed config the student joins a class themselves: pick a
// class heard on the network (or type a room name), enter the teacher's class
// key. Once a teacher has accepted the settings they're locked in, so students
// can't switch themselves out of a class; the window comes back only if the
// teacher later rejects the key.

import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { Socket } from 'node:dgram';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { loadStudentConfig, readUserConfig, saveUserConfig, type StudentConfig } from './config';
import { watchBeacons } from './connection';
import type { DiscoveredClass, SetupDetails, SetupStatus } from './ipc';
import { changed, state } from './state';

let setup: BrowserWindow | null = null;
let setupBeacons: Socket | null = null;
let setupPrune: NodeJS.Timeout | null = null;
let setupWait: NodeJS.Timeout | null = null;
const discovered = new Map<string, DiscoveredClass & { seen: number }>();

let preload = '';
let startLink: (config: StudentConfig) => void = () => {};

export function initSetup(options: { preload: string; startLink: (config: StudentConfig) => void }): void {
  preload = options.preload;
  startLink = options.startLink;

  const fromSetup = (e: IpcMainEvent | IpcMainInvokeEvent) => setup !== null && e.sender === setup.webContents;
  ipcMain.handle('student:setup-initial', (e) => {
    if (!fromSetup(e)) throw new Error('unknown sender');
    const saved = readUserConfig(app.getPath('userData'));
    return { room: saved.room ?? '', classKey: saved.classKey ?? '', teacherHost: saved.teacherHost ?? '', platform: process.platform };
  });
  ipcMain.handle('student:setup-join', (e, details: SetupDetails) => {
    if (!fromSetup(e) || state.managed) throw new Error('unknown sender');
    joinClass(details);
  });
  ipcMain.on('student:setup-close', (e) => fromSetup(e) && setup?.close());
}

export function canOfferSetup(): boolean {
  if (state.managed) return false;
  return !state.config || state.problem === 'key' || !readUserConfig(app.getPath('userData')).confirmed;
}

/** A teacher accepted this computer: lock in the student's own settings. */
export function confirmUserConfig(): void {
  const dir = app.getPath('userData');
  const saved = readUserConfig(dir);
  if (state.managed || saved.confirmed || !saved.room || !saved.classKey) return;
  saveUserConfig(dir, { room: saved.room, classKey: saved.classKey, teacherHost: saved.teacherHost, confirmed: true });
}

export function openSetup(): void {
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
    discovered.set(beacon.room, {
      room: beacon.room,
      teacher: beacon.teacher,
      host: known?.host ?? host,
      compatible: beacon.v === PROTOCOL_VERSION,
      seen: Date.now(),
    });
    if (!known) pushClasses();
  });
  setupPrune = setInterval(() => {
    for (const [room, c] of discovered) if (Date.now() - c.seen > 7000) discovered.delete(room);
    pushClasses();
  }, 2000);
}

function pushClasses(): void {
  const classes = [...discovered.values()]
    .map(({ room, teacher, host, compatible }) => ({ room, teacher, host, compatible }))
    .sort((a, b) => a.room.localeCompare(b.room));
  setup?.webContents.send('student:setup-classes', classes);
}

export function sendSetupStatus(status: SetupStatus): void {
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
  if (teacherHost && !/^[\w.:-]{1,253}$/.test(teacherHost)) throw new Error("That teacher address doesn't look right.");

  const dir = app.getPath('userData');
  saveUserConfig(dir, { room, classKey, teacherHost, confirmed: false });
  const next = loadStudentConfig(dir);
  if (!next) throw new Error('Could not save the settings.');
  startLink(next);
  changed();
  sendSetupStatus({ state: 'connecting', room });
  setupWait = setTimeout(() => {
    setupWait = null;
    if (!state.link?.connected && !state.problem) sendSetupStatus({ state: 'waiting', room });
  }, 8000);
}
