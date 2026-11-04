import { contextBridge, ipcRenderer } from 'electron';
import type { TeacherApi, TeacherEvent } from './ipc';

const api: TeacherApi = {
  state: () => ipcRenderer.invoke('teacher:state'),
  saveSettings: (settings) => ipcRenderer.invoke('teacher:save-settings', settings),
  generateKey: () => ipcRenderer.invoke('teacher:generate-key'),
  copy: (text) => ipcRenderer.send('teacher:copy', text),
  forget: (id) => ipcRenderer.send('teacher:forget', id),
  lock: (target, message) => ipcRenderer.send('teacher:lock', target, message),
  unlock: (target) => ipcRenderer.send('teacher:unlock', target),
  viewStart: (id, sessionId) => ipcRenderer.send('teacher:view-start', id, sessionId),
  viewStop: (id, sessionId) => ipcRenderer.send('teacher:view-stop', id, sessionId),
  control: (id, sessionId, enabled) => ipcRenderer.send('teacher:control', id, sessionId, enabled),
  input: (id, sessionId, events) => ipcRenderer.send('teacher:input', id, sessionId, events),
  broadcastStart: (target, sessionId) => ipcRenderer.send('teacher:broadcast-start', target, sessionId),
  broadcastStop: () => ipcRenderer.send('teacher:broadcast-stop'),
  signal: (id, sessionId, signal) => ipcRenderer.send('teacher:signal', id, sessionId, signal),
  message: (target, text) => ipcRenderer.invoke('teacher:message', target, text),
  chat: (id, text) => ipcRenderer.invoke('teacher:chat', id, text),
  handClear: (id) => ipcRenderer.send('teacher:hand-clear', id),
  pollStart: (target, question, choices) => ipcRenderer.invoke('teacher:poll-start', target, question, choices),
  pollEnd: () => ipcRenderer.send('teacher:poll-end'),
  attention: (title, body) => ipcRenderer.send('teacher:attention', title, body),
  saveGroups: (groups) => ipcRenderer.invoke('teacher:save-groups', groups),
  registerStart: (target) => ipcRenderer.invoke('teacher:register-start', target),
  registerEnd: () => ipcRenderer.send('teacher:register-end'),
  saveCsv: (defaultName, rows) => ipcRenderer.invoke('teacher:save-csv', defaultName, rows),
  sendFiles: (target) => ipcRenderer.invoke('teacher:send-files', target),
  collectStart: (target, title) => ipcRenderer.invoke('teacher:collect-start', target, title),
  collectEnd: () => ipcRenderer.send('teacher:collect-end'),
  openFolder: (folder) => ipcRenderer.send('teacher:open-folder', folder),
  onEvent: (listener) => {
    ipcRenderer.on('teacher:event', (_e, event: TeacherEvent) => listener(event));
  },
};

contextBridge.exposeInMainWorld('teacher', api);
