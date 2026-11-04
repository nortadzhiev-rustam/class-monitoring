// Student agent entry point: connects to the teacher and routes commands to the
// modules that carry them out.

import { app, globalShortcut, ipcMain, Menu, screen, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureApp, shareScreenWithoutPicker } from '../shared/electron-setup';
import { LIMITS, type Platform, type Policy, type RtcSignal, type StudentInfo, type TeacherMessage } from '../shared/protocol';
import { setBlockedApps } from './app-blocker';
import { initChat, openChat, receiveChat, refreshChat, resetChat } from './chat';
import { isManagedConfig, loadStudentConfig, type StudentConfig } from './config';
import { TeacherLink } from './connection';
import { handleFileMessage, resetFiles, showCollect } from './files';
import { handNote, lowerHand } from './hand';
import { openApp, openUrl } from './launch';
import { Overlay } from './overlay';
import { schedulePower } from './power';
import { initPrompts, onPromptAction, removePrompt, removePrompts, showPrompt } from './prompts';
import { showRegister } from './register';
import * as session from './session';
import { canOfferSetup, confirmUserConfig, initSetup, openSetup, sendSetupStatus } from './setup';
import { changed, onChange, send, state } from './state';
import { configure as configureThumbnails, startThumbnails } from './thumbnails';
import { createTray, popUpTray, updateTray } from './tray';

configureApp('Student');

if (!app.requestSingleInstanceLock()) app.exit(0);

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

function displays(): StudentInfo['displays'] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({ id: String(d.id), bounds: d.bounds, primary: d.id === primary }));
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
    displays: displays(),
    version: app.getVersion(),
  };
}

function reportStatus(): void {
  send({ type: 'status', locked: overlay.locked, viewing: session.viewing(), controlled: session.controlled(), hand: handNote() });
}

// ---------------------------------------------------------------- teacher commands

/** Brings this computer in line with the teacher's policy; safe to apply repeatedly. */
function applyPolicy(policy: Policy): void {
  if (policy.lock !== null) overlay.lock(policy.lock || 'Your teacher has locked this screen.');
  else if (overlay.locked) overlay.unlock();
  if (policy.broadcast) overlay.startBroadcast(policy.broadcast);
  else if (overlay.broadcastSession) overlay.stopBroadcast();
  showPoll(policy.poll);
  void showRegister(policy.register);
  showCollect(policy.collect);
  setBlockedApps(policy.apps);
  changed();
}

// ---------------------------------------------------------------- polls

/** The student's answer per poll, so it survives a reconnect mid-poll. */
const pollAnswers = new Map<string, number>();

function showPoll(poll: Policy['poll']): void {
  removePrompts((c) => c.kind === 'poll' && c.pollId !== poll?.pollId);
  if (!poll) return;
  const choices = poll.choices.slice(0, LIMITS.pollChoices).map((c) => String(c).slice(0, LIMITS.pollChoice));
  const answer = pollAnswers.get(poll.pollId) ?? null;
  showPrompt({
    id: `poll-${poll.pollId}`,
    kind: 'poll',
    pollId: poll.pollId,
    from: state.teacher?.name ?? 'Your teacher',
    question: String(poll.question).slice(0, LIMITS.pollQuestion),
    choices,
    answer,
  });
  if (answer !== null) send({ type: 'poll-answer', pollId: poll.pollId, choice: answer });
}

onPromptAction('poll', (card, action, value) => {
  if (card.kind !== 'poll' || action !== 'answer' || typeof value !== 'number' || !card.choices[value]) return;
  pollAnswers.set(card.pollId, value);
  showPrompt({ ...card, answer: value });
  send({ type: 'poll-answer', pollId: card.pollId, choice: value });
});

onPromptAction('message', (card, action) => {
  if (action === 'dismiss') removePrompt(card.id);
});

function onTeacherMessage(msg: TeacherMessage, payload: Buffer | undefined): void {
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
      void session.startView(msg.sessionId, typeof msg.displayId === 'string' ? msg.displayId : undefined);
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
    case 'message':
      showPrompt({
        id: `message-${String(msg.id).slice(0, 64)}`,
        kind: 'message',
        from: state.teacher?.name ?? 'Your teacher',
        text: String(msg.text).slice(0, LIMITS.message),
        at: Date.now(),
      });
      break;
    case 'chat':
      receiveChat(msg.id, msg.text);
      break;
    case 'hand-clear':
      lowerHand();
      break;
    case 'open-url':
      openUrl(msg.url);
      break;
    case 'open-app':
      openApp(msg.name);
      break;
    case 'power':
      schedulePower(msg.action, msg.delay);
      break;
    case 'file-start':
    case 'file-chunk':
    case 'file-end':
    case 'file-ack':
      handleFileMessage(msg, payload);
      break;
  }
}

/** Drops everything the teacher had turned on, so a lost connection never leaves the student locked. */
function resetSession(): void {
  session.endAll();
  overlay.clear();
  setBlockedApps(null);
  // Cards that only make sense while the teacher is there go away with them.
  removePrompts((c) => c.kind === 'poll' || c.kind === 'sign-in' || c.kind === 'collect');
  resetFiles();
  state.teacher = null;
  changed();
}

function startLink(next: StudentConfig): void {
  if (state.link) {
    state.link.removeAllListeners();
    state.link.stop();
    resetSession();
    resetChat();
    lowerHand();
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

app.on('second-instance', () => {
  if (canOfferSetup()) openSetup();
  else if (state.teacher) openChat();
  else popUpTray();
});
// No window to close, no menu and no Dock icon, so students have no way to quit
// the agent; it runs until logout. Quitting is never blocked, so logging out
// and shutting down always work.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  app.dock?.hide();
  Menu.setApplicationMenu(null);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  shareScreenWithoutPicker();

  overlay = new Overlay(preload);
  registerIpc();
  initPrompts(preload);
  initChat(preload);
  initSetup({ preload, startLink });
  session.createAgentWindow(preload);
  createTray();
  onChange(() => {
    reportStatus();
    updateTray();
    refreshChat();
  });
  // Monitors plugged in, removed or rearranged: the teacher's thumbnail and screen list follow.
  const displaysChanged = () => state.link?.connected && send({ type: 'info', info: studentInfo(studentId()) });
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);

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
