// Types shared by the student's main process, preload and renderers
// (the hidden capture window, the lock/broadcast overlays and the setup window).

import type { FrameMeta, PowerAction } from '../shared/protocol';

export interface OverlayState {
  mode: 'lock' | 'broadcast';
  message: string;
  teacher: string;
  sessionId: string | null;
  /** Whose screen is shown: the teacher's name, or a classmate's. */
  presenter: string;
  /** Only the primary display's overlay plays the shown screen. */
  primary: boolean;
}

/** For the hidden capture window. `sourceId` is the desktopCapturer id of the monitor to stream. */
export type ViewCommand =
  | { type: 'start'; sessionId: string; sourceId: string; bitrate: number }
  | { type: 'stop'; sessionId: string }
  | { type: 'keyframe'; sessionId: string }
  | { type: 'bitrate'; sessionId: string; bitrate: number };

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
  | { id: string; kind: 'hand' }
  | { id: string; kind: 'sign-in'; registerId: string; from: string; name: string; done: boolean; error: string | null }
  | { id: string; kind: 'file'; from: string; name: string; path: string }
  | { id: string; kind: 'collect'; collectId: string; title: string; from: string; handedIn: string[]; sending: string[]; error: string | null }
  | { id: string; kind: 'notice'; title: string; text: string }
  /** The countdown before a power action, or before the teacher closes the student's apps. */
  | { id: string; kind: 'power'; action: PowerAction | 'close-apps'; deadline: number };

/** What the toolbar at the top of the screen shows while the teacher is connected. */
export interface ToolbarState {
  teacher: string;
  room: string;
  handRaised: boolean;
  /** Chat messages from the teacher the student hasn't looked at yet. */
  unread: number;
  /** Title of the work the teacher is collecting, or null. */
  collect: string | null;
  /** The teacher is watching this screen right now / controlling this computer. */
  viewing: boolean;
  controlled: boolean;
  /** This screen is being shown to the class. */
  presenting: boolean;
  /** Website rules or blocked apps are on. */
  webLimited: boolean;
  appsBlocked: boolean;
  /** The teacher has turned this computer's sound off. */
  muted: boolean;
}

export const TOOLBAR_ACTIONS = ['hand', 'chat', 'hand-in'] as const;
export type ToolbarAction = (typeof TOOLBAR_ACTIONS)[number];

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
  // Hidden capture window
  onViewCommand(listener: (command: ViewCommand) => void): void;
  /** One encoded frame of this computer's screen for the teacher's remote view. */
  viewFrame(sessionId: string, meta: FrameMeta, data: Uint8Array): void;
  /** Live video couldn't start (or stopped working) for this remote view. */
  viewError(sessionId: string, message: string): void;
  /** The screen capture for this remote view stopped by itself (it can be started again). */
  viewEnded(sessionId: string, message: string): void;

  // Overlay windows
  overlayReady(): void;
  onOverlayState(listener: (state: OverlayState) => void): void;
  /** The overlay can show the broadcast; sent again after a decoding problem, for a fresh keyframe. */
  broadcastReady(sessionId: string): void;
  onBroadcastFrame(listener: (sessionId: string, meta: FrameMeta, data: Uint8Array) => void): void;

  // Setup window
  setupInitial(): Promise<{ room: string; classKey: string; teacherHost: string; platform: string }>;
  setupJoin(details: SetupDetails): Promise<void>;
  setupClose(): void;
  onSetupClasses(listener: (classes: DiscoveredClass[]) => void): void;
  onSetupStatus(listener: (status: SetupStatus) => void): void;

  // Prompt window
  promptsReady(): void;
  onPrompts(listener: (cards: PromptCard[]) => void): void;
  promptAction(id: string, action: string, value?: number | string): void;
  /** Reports the content height so the window can fit it. */
  promptsSize(height: number): void;

  // Toolbar
  toolbarReady(): void;
  onToolbar(listener: (state: ToolbarState) => void): void;
  toolbarAction(action: ToolbarAction): void;
  /** Whether the pointer is over the bar; elsewhere, clicks pass through to the apps below. */
  toolbarPointer(over: boolean): void;

  // Chat window
  chatReady(): void;
  onChat(listener: (state: ChatState) => void): void;
  chatSend(text: string): void;
  setHand(raised: boolean): void;
}
