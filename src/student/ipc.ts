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
}
