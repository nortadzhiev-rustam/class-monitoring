import { contextBridge, ipcRenderer } from 'electron';
import type { FrameMeta } from '../shared/protocol';
import type { ChatState, DiscoveredClass, OverlayState, PromptCard, SetupStatus, StudentApi, ToolbarState, ViewCommand } from './ipc';

const api: StudentApi = {
  onViewCommand: (listener) => {
    ipcRenderer.on('student:view', (_e, command: ViewCommand) => listener(command));
  },
  viewFrame: (sessionId, meta, data) => ipcRenderer.send('student:view-frame', sessionId, meta, data),
  viewError: (sessionId, message) => ipcRenderer.send('student:view-error', sessionId, message),
  viewEnded: (sessionId, message) => ipcRenderer.send('student:view-ended', sessionId, message),
  overlayReady: () => ipcRenderer.send('student:overlay-ready'),
  onOverlayState: (listener) => {
    ipcRenderer.on('student:overlay-state', (_e, state: OverlayState) => listener(state));
  },
  broadcastReady: (sessionId) => ipcRenderer.send('student:broadcast-ready', sessionId),
  onBroadcastFrame: (listener) => {
    ipcRenderer.on('student:broadcast-frame', (_e, sessionId: string, meta: FrameMeta, data: Uint8Array) => listener(sessionId, meta, data));
  },
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
  toolbarReady: () => ipcRenderer.send('student:toolbar-ready'),
  onToolbar: (listener) => {
    ipcRenderer.on('student:toolbar', (_e, state: ToolbarState) => listener(state));
  },
  toolbarAction: (action) => ipcRenderer.send('student:toolbar-action', action),
  toolbarPointer: (over) => ipcRenderer.send('student:toolbar-pointer', over),
  chatReady: () => ipcRenderer.send('student:chat-ready'),
  onChat: (listener) => {
    ipcRenderer.on('student:chat', (_e, state: ChatState) => listener(state));
  },
  chatSend: (text) => ipcRenderer.send('student:chat-send', text),
  setHand: (raised) => ipcRenderer.send('student:hand', raised),
};

contextBridge.exposeInMainWorld('student', api);
