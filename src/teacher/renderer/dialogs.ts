// Modal dialogs: lock message, student message and class settings.

import type { TeacherState } from '../ipc';
import { $, api, errorText } from './dom';
import type { Resolved } from './targets';

const lockDialog = $<HTMLDialogElement>('#lock-dialog');
const lockMessage = $<HTMLTextAreaElement>('#lock-message');
const settingsDialog = $<HTMLDialogElement>('#settings-dialog');

/** True while any dialog is up, so keystrokes stay in the console. */
export const anyOpen = () => [...document.querySelectorAll('dialog')].some((d) => d.open);

let onLockConfirmed: ((message: string) => void) | null = null;

export function askLock(to: Resolved, confirm: (message: string) => void): void {
  onLockConfirmed = confirm;
  $('#lock-title').textContent = to.target.everyone ? 'Lock everyone' : `Lock ${to.label}`;
  lockDialog.returnValue = '';
  lockDialog.showModal();
  lockMessage.select();
}

lockDialog.addEventListener('close', () => {
  const confirm = onLockConfirmed;
  onLockConfirmed = null;
  if (lockDialog.returnValue === 'ok') confirm?.(lockMessage.value.trim());
});

// ---------------------------------------------------------------- message

const messageDialog = $<HTMLDialogElement>('#message-dialog');
const messageText = $<HTMLTextAreaElement>('#message-text');
let onMessageConfirmed: ((text: string) => void) | null = null;

export function askMessage(to: Resolved, confirm: (text: string) => void): void {
  onMessageConfirmed = confirm;
  $('#message-title').textContent = to.target.everyone ? 'Message everyone' : `Message ${to.label}`;
  messageText.value = '';
  messageDialog.returnValue = '';
  messageDialog.showModal();
  messageText.focus();
}

messageDialog.addEventListener('close', () => {
  const confirm = onMessageConfirmed;
  onMessageConfirmed = null;
  if (messageDialog.returnValue === 'ok' && messageText.value.trim()) confirm?.(messageText.value.trim());
});

// ---------------------------------------------------------------- settings

const setRoom = $<HTMLInputElement>('#set-room');
const setName = $<HTMLInputElement>('#set-name');
const setKey = $<HTMLInputElement>('#set-key');
let state: TeacherState;
let onSaved: (next: TeacherState) => void = () => {};
let beforeSave: () => void = () => {};

function studentConfigSnippet(): string {
  const config = {
    room: setRoom.value.trim(),
    classKey: setKey.value.trim(),
    teacherHost: state.addresses[0] ?? '',
  };
  return JSON.stringify(config, null, 2);
}

export function initSettings(options: { beforeSave: () => void; saved: (next: TeacherState) => void }): void {
  beforeSave = options.beforeSave;
  onSaved = options.saved;
}

export function openSettings(current: TeacherState): void {
  state = current;
  setRoom.value = state.settings.room;
  setName.value = state.settings.teacherName;
  setKey.value = state.settings.classKey;
  $('#set-snippet').textContent = studentConfigSnippet();
  $('#settings-error').hidden = true;
  settingsDialog.returnValue = '';
  settingsDialog.showModal();
}

$('#config-path-win').textContent = 'C:\\ProgramData\\ClassMonitor\\student.json';
$('#config-path-mac').textContent = '/Library/Application Support/ClassMonitor/student.json';
for (const input of [setRoom, setKey]) input.addEventListener('input', () => ($('#set-snippet').textContent = studentConfigSnippet()));
$('#copy-key').addEventListener('click', () => api.copy(setKey.value.trim()));
$('#new-key').addEventListener('click', async () => {
  setKey.value = await api.generateKey();
  $('#set-snippet').textContent = studentConfigSnippet();
});

$('#settings-form').addEventListener('submit', async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save') return;
  e.preventDefault();
  beforeSave();
  try {
    const next = await api.saveSettings({ room: setRoom.value, teacherName: setName.value, classKey: setKey.value });
    settingsDialog.close();
    onSaved(next);
  } catch (err) {
    const el = $('#settings-error');
    el.textContent = errorText(err);
    el.hidden = false;
  }
});
