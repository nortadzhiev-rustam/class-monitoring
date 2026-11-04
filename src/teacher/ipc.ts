// Types shared by the teacher's main process, preload and renderer.

import type { InputEvent, Platform, Policy, RtcSignal, StudentInfo } from '../shared/protocol';

export interface StudentStatus {
  locked: boolean;
  viewing: boolean;
  controlled: boolean;
}

export interface StudentSummary {
  info: StudentInfo;
  address: string;
  status: StudentStatus;
  policy: Policy;
}

/** A computer the console has seen before, online or not. */
export interface RosterEntry {
  id: string;
  hostname: string;
  username: string;
  platform: Platform;
  macs: string[];
  address: string;
  lastSeen: number;
}

/**
 * Who an action applies to. `everyone` also makes it the class default, so
 * computers that join later get it too.
 */
export interface Target {
  ids: string[];
  everyone: boolean;
}

export interface TeacherSettings {
  room: string;
  teacherName: string;
  classKey: string;
}

export interface TeacherState {
  settings: TeacherSettings;
  port: number;
  addresses: string[];
  students: StudentSummary[];
  roster: RosterEntry[];
  platform: Platform;
}

export type TeacherEvent =
  | { type: 'joined'; student: StudentSummary; entry: RosterEntry }
  | { type: 'left'; id: string }
  | { type: 'status'; id: string; status: StudentStatus }
  | { type: 'policy'; id: string; policy: Policy }
  | { type: 'thumb'; id: string; jpeg: Uint8Array }
  | { type: 'signal'; id: string; sessionId: string; signal: RtcSignal }
  | { type: 'broadcast-ready'; id: string; sessionId: string }
  | { type: 'student-error'; id: string; sessionId?: string; message: string }
  /** A computer tried to join but runs a different ClassMonitor version. */
  | { type: 'version-mismatch'; address: string };

export interface TeacherApi {
  state(): Promise<TeacherState>;
  saveSettings(settings: TeacherSettings): Promise<TeacherState>;
  generateKey(): Promise<string>;
  copy(text: string): void;
  forget(id: string): void;
  lock(target: Target, message: string): void;
  unlock(target: Target): void;
  viewStart(id: string, sessionId: string): void;
  viewStop(id: string, sessionId: string): void;
  /** While enabled, the main process mutes the console's own shortcuts so keys reach the student. */
  control(id: string, sessionId: string, enabled: boolean): void;
  input(id: string, sessionId: string, events: InputEvent[]): void;
  broadcastStart(target: Target, sessionId: string): void;
  broadcastStop(): void;
  signal(id: string, sessionId: string, signal: RtcSignal): void;
  onEvent(listener: (event: TeacherEvent) => void): void;
}
