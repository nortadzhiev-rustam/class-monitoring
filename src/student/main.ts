// Student agent entry point: connects to the teacher and routes commands to the
// modules that carry them out.

import { app, globalShortcut, ipcMain, Menu, screen, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureApp, shareScreenWithoutPicker } from '../shared/electron-setup';
import type { Platform, Policy, RtcSignal, StudentInfo, TeacherMessage } from '../shared/protocol';
import { isManagedConfig, loadStudentConfig, type StudentConfig } from './config';
import { TeacherLink } from './connection';
import { Overlay } from './overlay';
import * as session from './session';
import { canOfferSetup, confirmUserConfig, initSetup, openSetup, sendSetupStatus } from './setup';
import { changed, onChange, send, state } from './state';
import { configure as configureThumbnails, startThumbnails } from './thumbnails';
import { createTray, popUpTray, updateTray } from './tray';

configureApp('Student');

if (!app.requestSingleInstanceLock()) app.exit(0);

const canQuit = !app.isPackaged || process.env.CM_ALLOW_QUIT === '1';
const preload = path.join(__dirname, 'preload.js');
let overlay: Overlay;

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

function macAddresses(): string[] {
  const macs = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') macs.add(a.mac);
  }
  return [...macs];
}

function studentInfo(id: string): StudentInfo {
  const { width, height } = screen.getPrimaryDisplay().size;
  return {
    id,
    hostname: state.config?.displayName ?? os.hostname(),
    username: os.userInfo().username,
    platform: process.platform as Platform,
    screen: { width, height },
    macs: macAddresses(),
    version: app.getVersion(),
  };
}

function reportStatus(): void {
  send({ type: 'status', locked: overlay.locked, viewing: session.viewing(), controlled: session.controlled() });
}

// ---------------------------------------------------------------- teacher commands

/** Brings this computer in line with the teacher's policy; safe to apply repeatedly. */
function applyPolicy(policy: Policy): void {
  if (policy.lock !== null) overlay.lock(policy.lock || 'Your teacher has locked this screen.');
  else if (overlay.locked) overlay.unlock();
  if (policy.broadcast) overlay.startBroadcast(policy.broadcast);
  else if (overlay.broadcastSession) overlay.stopBroadcast();
  changed();
}

function onTeacherMessage(msg: TeacherMessage): void {
  switch (msg.type) {
    case 'welcome':
      state.teacher = { name: msg.teacher, room: msg.room };
      overlay.setTeacher(msg.teacher);
      changed();
      break;
    case 'thumb-config':
      configureThumbnails(msg.intervalMs, msg.width);
      break;
    case 'policy':
      applyPolicy(msg.policy);
      break;
    case 'view-start':
      session.startView(msg.sessionId);
      break;
    case 'view-stop':
      session.endView(msg.sessionId);
      break;
    case 'control':
      session.setControl(msg.sessionId, msg.enabled, msg.teacherPlatform);
      break;
    case 'input':
      session.inject(msg.sessionId, msg.events);
      break;
    case 'signal':
      if (session.owns(msg.sessionId)) session.relaySignal(msg.sessionId, msg.signal);
      else overlay.sendSignal(msg.sessionId, msg.signal);
      break;
  }
}

/** Drops everything the teacher had turned on, so a lost connection never leaves the student locked. */
function resetSession(): void {
  session.endAll();
  overlay.clear();
  state.teacher = null;
  changed();
}

function startLink(next: StudentConfig): void {
  if (state.link) {
    state.link.removeAllListeners();
    state.link.stop();
    resetSession();
  }
  state.config = next;
  state.problem = null;
  const id = studentId();
  const link = new TeacherLink(next, () => studentInfo(id));
  state.link = link;
  link.on('message', onTeacherMessage);
  link.on('disconnected', resetSession);
  link.on('connected', ({ teacher, room }) => {
    state.problem = null;
    confirmUserConfig();
    sendSetupStatus({ state: 'connected', teacher, room });
  });
  link.on('failed', (_message, reason) => {
    if (reason === 'other') return;
    state.problem = reason;
    if (reason === 'key') sendSetupStatus({ state: 'rejected' });
    changed();
  });
  link.start();
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  const fromOverlay = (e: IpcMainEvent) => overlay.owns(e.sender);

  ipcMain.on('student:signal', (e, sessionId: string, signal: RtcSignal) => {
    const allowed = session.isAgent(e.sender) ? session.owns(sessionId) : fromOverlay(e) && sessionId === overlay.broadcastSession;
    if (allowed) send({ type: 'signal', sessionId, signal });
  });
  ipcMain.on('student:view-error', (e, sessionId: string, message: string) => {
    if (!session.isAgent(e.sender)) return;
    send({ type: 'error', sessionId, message });
    session.endView(sessionId);
  });
  ipcMain.on('student:overlay-ready', (e) => fromOverlay(e) && overlay.pushState(e.sender));
  ipcMain.on('student:broadcast-ready', (e, sessionId: string) => {
    if (fromOverlay(e) && sessionId === overlay.broadcastSession) send({ type: 'broadcast-ready', sessionId });
  });
}

app.on('second-instance', () => (canOfferSetup() ? openSetup() : popUpTray()));
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
  registerIpc();
  initSetup({ preload, startLink });
  session.createAgentWindow(preload);
  createTray();
  onChange(() => {
    reportStatus();
    updateTray();
  });

  if (!app.isPackaged) {
    // Escape hatch while developing the lock screen.
    globalShortcut.register('CommandOrControl+Alt+Shift+U', () => overlay.clear());
  }

  state.managed = isManagedConfig();
  const saved = loadStudentConfig(app.getPath('userData'));
  if (saved) startLink(saved);
  else openSetup();
  startThumbnails();
  updateTray();
});
