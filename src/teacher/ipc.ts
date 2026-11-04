// Types shared by the teacher's main process, preload and renderer.

import type { Collect, InputEvent, Platform, Policy, Poll, RtcSignal, StudentInfo } from '../shared/protocol';

export interface StudentStatus {
  locked: boolean;
  viewing: boolean;
  controlled: boolean;
  /** Help note while the student's hand is raised ('' for no note), else null. */
  hand: string | null;
}

export interface ChatMessage {
  id: string;
  from: 'teacher' | 'student';
  text: string;
  at: number;
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
  /** Name typed when signing in to a register. */
  name?: string;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
}

/** Progress of one file going to one student. */
export interface Transfer {
  transferId: string;
  batchId: string;
  id: string;
  name: string;
  size: number;
  sent: number;
  state: 'sending' | 'done' | 'failed';
  error?: string;
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
  groups: Group[];
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
  | { type: 'version-mismatch'; address: string }
  | { type: 'chat'; id: string; message: ChatMessage }
  | { type: 'poll-answer'; id: string; pollId: string; choice: number }
  | { type: 'sign-in'; id: string; registerId: string; name: string }
  | { type: 'transfer'; transfer: Transfer }
  /** A student handed in a file for the current collection. */
  | { type: 'collected'; id: string; collectId: string; name: string; size: number };

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
  /** Pops up a message on the targets' screens; resolves to how many received it. */
  message(target: Target, text: string): Promise<number>;
  /** Sends a chat message; resolves to the message as sent (for the transcript). */
  chat(id: string, text: string): Promise<ChatMessage>;
  handClear(id: string): void;
  pollStart(target: Target, question: string, choices: string[]): Promise<Poll>;
  pollEnd(): void;
  /** If the console isn't in front: a desktop notification plus a Dock bounce / taskbar flash. */
  attention(title: string, body?: string): void;
  saveGroups(groups: Group[]): Promise<Group[]>;
  registerStart(target: Target): Promise<string>;
  registerEnd(): void;
  /** Asks where to save, then writes the rows as CSV; resolves to the path or null if cancelled. */
  saveCsv(defaultName: string, rows: string[][]): Promise<string | null>;
  /** Picks files and sends them to the target's online students; null if cancelled. */
  sendFiles(target: Target): Promise<{ batchId: string; files: string[]; students: number } | null>;
  collectStart(target: Target, title: string): Promise<Collect & { folder: string }>;
  collectEnd(): void;
  openFolder(folder: string): void;
  onEvent(listener: (event: TeacherEvent) => void): void;
}
