// Types shared by the teacher's main process, preload and renderer.

import type { InputEvent, Platform, RtcSignal, StudentInfo } from '../shared/protocol';

export interface StudentStatus {
  locked: boolean;
  viewing: boolean;
  controlled: boolean;
}

export interface StudentSummary {
  info: StudentInfo;
  address: string;
  status: StudentStatus;
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
  platform: Platform;
}

export type TeacherEvent =
  | { type: 'joined'; student: StudentSummary }
  | { type: 'left'; id: string }
  | { type: 'status'; id: string; status: StudentStatus }
  | { type: 'thumb'; id: string; jpeg: Uint8Array }
  | { type: 'signal'; id: string; sessionId: string; signal: RtcSignal }
  | { type: 'broadcast-ready'; id: string; sessionId: string }
  | { type: 'student-error'; id: string; sessionId?: string; message: string };

export interface TeacherApi {
  state(): Promise<TeacherState>;
  saveSettings(settings: TeacherSettings): Promise<TeacherState>;
  generateKey(): Promise<string>;
  copy(text: string): void;
  lockAll(message: string): void;
  unlockAll(): void;
  lock(id: string, message: string): void;
  unlock(id: string): void;
  viewStart(id: string, sessionId: string): void;
  viewStop(id: string, sessionId: string): void;
  /** While enabled, the main process mutes the console's own shortcuts so keys reach the student. */
  control(id: string, sessionId: string, enabled: boolean): void;
  input(id: string, sessionId: string, events: InputEvent[]): void;
  broadcastStart(sessionId: string): void;
  broadcastStop(): void;
  signal(id: string, sessionId: string, signal: RtcSignal): void;
  onEvent(listener: (event: TeacherEvent) => void): void;
}
