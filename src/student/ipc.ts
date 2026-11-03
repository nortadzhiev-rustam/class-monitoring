// Types shared by the student's main process, preload and renderers
// (the hidden capture window and the lock/broadcast overlays).

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
}
