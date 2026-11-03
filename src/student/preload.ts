import { contextBridge, ipcRenderer } from 'electron';
import type { RtcSignal } from '../shared/protocol';
import type { DiscoveredClass, OverlayState, SetupStatus, StudentApi, ViewCommand } from './ipc';

const api: StudentApi = {
  signal: (sessionId, signal) => ipcRenderer.send('student:signal', sessionId, signal),
  onSignal: (listener) => {
    ipcRenderer.on('student:signal', (_e, sessionId: string, signal: RtcSignal) => listener(sessionId, signal));
  },
  onViewCommand: (listener) => {
    ipcRenderer.on('student:view', (_e, command: ViewCommand) => listener(command));
  },
  viewError: (sessionId, message) => ipcRenderer.send('student:view-error', sessionId, message),
  overlayReady: () => ipcRenderer.send('student:overlay-ready'),
  onOverlayState: (listener) => {
    ipcRenderer.on('student:overlay-state', (_e, state: OverlayState) => listener(state));
  },
  broadcastReady: (sessionId) => ipcRenderer.send('student:broadcast-ready', sessionId),
  setupInitial: () => ipcRenderer.invoke('student:setup-initial'),
  setupJoin: (details) => ipcRenderer.invoke('student:setup-join', details),
  setupClose: () => ipcRenderer.send('student:setup-close'),
  onSetupClasses: (listener) => {
    ipcRenderer.on('student:setup-classes', (_e, classes: DiscoveredClass[]) => listener(classes));
  },
  onSetupStatus: (listener) => {
    ipcRenderer.on('student:setup-status', (_e, status: SetupStatus) => listener(status));
  },
};

contextBridge.exposeInMainWorld('student', api);
