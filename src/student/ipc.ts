// Types shared by the student's main process, preload and renderers
// (the hidden capture window, the lock/broadcast overlays and the setup window).

import type { RtcSignal } from '../shared/protocol';

export interface OverlayState {
  mode: 'lock' | 'broadcast';
  message: string;
  teacher: string;
  sessionId: string | null;
  /** Only the primary display's overlay plays the teacher's screen. */
  primary: boolean;
}

export type ViewCommand = { type: 'start' | 'stop'; sessionId: string };

/** A teacher console heard on the network. */
export interface DiscoveredClass {
  room: string;
  teacher: string;
  host: string;
  /** False when the teacher runs a different ClassMonitor version. */
  compatible: boolean;
}

export interface SetupDetails {
  room: string;
  classKey: string;
  teacherHost?: string;
}

export type SetupStatus =
  | { state: 'connecting'; room: string }
  | { state: 'connected'; teacher: string; room: string }
  | { state: 'rejected' }
  | { state: 'waiting'; room: string };

/** One item in the always-on-top prompt window. */
export type PromptCard =
  | { id: string; kind: 'message'; from: string; text: string; at: number }
  | { id: string; kind: 'poll'; pollId: string; from: string; question: string; choices: string[]; answer: number | null }
  | { id: string; kind: 'hand' };

export interface ChatLine {
  id: string;
  from: 'teacher' | 'me';
  text: string;
  at: number;
}

export interface ChatState {
  teacher: string | null;
  lines: ChatLine[];
  handRaised: boolean;
}

export interface StudentApi {
  signal(sessionId: string, signal: RtcSignal): void;
  onSignal(listener: (sessionId: string, signal: RtcSignal) => void): void;

  // Hidden capture window
  onViewCommand(listener: (command: ViewCommand) => void): void;
  viewError(sessionId: string, message: string): void;

  // Overlay windows
  overlayReady(): void;
  onOverlayState(listener: (state: OverlayState) => void): void;
  broadcastReady(sessionId: string): void;

  // Setup window
  setupInitial(): Promise<{ room: string; classKey: string; teacherHost: string; platform: string }>;
  setupJoin(details: SetupDetails): Promise<void>;
  setupClose(): void;
  onSetupClasses(listener: (classes: DiscoveredClass[]) => void): void;
  onSetupStatus(listener: (status: SetupStatus) => void): void;

  // Prompt window
  promptsReady(): void;
  onPrompts(listener: (cards: PromptCard[]) => void): void;
  promptAction(id: string, action: string, value?: number): void;
  /** Reports the content height so the window can fit it. */
  promptsSize(height: number): void;

  // Chat window
  chatReady(): void;
  onChat(listener: (state: ChatState) => void): void;
  chatSend(text: string): void;
  setHand(raised: boolean): void;
}
