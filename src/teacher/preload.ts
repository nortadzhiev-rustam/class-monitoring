import { contextBridge, ipcRenderer } from 'electron';
import type { TeacherApi, TeacherEvent } from './ipc';

const api: TeacherApi = {
  state: () => ipcRenderer.invoke('teacher:state'),
  saveSettings: (settings) => ipcRenderer.invoke('teacher:save-settings', settings),
  generateKey: () => ipcRenderer.invoke('teacher:generate-key'),
  copy: (text) => ipcRenderer.send('teacher:copy', text),
  lockAll: (message) => ipcRenderer.send('teacher:lock-all', message),
  unlockAll: () => ipcRenderer.send('teacher:unlock-all'),
  lock: (id, message) => ipcRenderer.send('teacher:lock', id, message),
  unlock: (id) => ipcRenderer.send('teacher:unlock', id),
  viewStart: (id, sessionId) => ipcRenderer.send('teacher:view-start', id, sessionId),
  viewStop: (id, sessionId) => ipcRenderer.send('teacher:view-stop', id, sessionId),
  control: (id, sessionId, enabled) => ipcRenderer.send('teacher:control', id, sessionId, enabled),
  input: (id, sessionId, events) => ipcRenderer.send('teacher:input', id, sessionId, events),
  broadcastStart: (sessionId) => ipcRenderer.send('teacher:broadcast-start', sessionId),
  broadcastStop: () => ipcRenderer.send('teacher:broadcast-stop'),
  signal: (id, sessionId, signal) => ipcRenderer.send('teacher:signal', id, sessionId, signal),
  onEvent: (listener) => {
    ipcRenderer.on('teacher:event', (_e, event: TeacherEvent) => listener(event));
  },
};

contextBridge.exposeInMainWorld('teacher', api);
