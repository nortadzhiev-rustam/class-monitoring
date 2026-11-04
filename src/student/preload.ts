import { contextBridge, ipcRenderer } from 'electron';
import type { RtcSignal } from '../shared/protocol';
import type { ChatState, DiscoveredClass, OverlayState, PromptCard, SetupStatus, StudentApi, ViewCommand } from './ipc';

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
  promptsReady: () => ipcRenderer.send('student:prompts-ready'),
  onPrompts: (listener) => {
    ipcRenderer.on('student:prompts', (_e, cards: PromptCard[]) => listener(cards));
  },
  promptAction: (id, action, value) => ipcRenderer.send('student:prompt-action', id, action, value),
  promptsSize: (height) => ipcRenderer.send('student:prompts-size', height),
  chatReady: () => ipcRenderer.send('student:chat-ready'),
  onChat: (listener) => {
    ipcRenderer.on('student:chat', (_e, state: ChatState) => listener(state));
  },
  chatSend: (text) => ipcRenderer.send('student:chat-send', text),
  setHand: (raised) => ipcRenderer.send('student:hand', raised),
};

contextBridge.exposeInMainWorld('student', api);
