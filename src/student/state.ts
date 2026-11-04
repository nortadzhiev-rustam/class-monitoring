// State shared by the student agent's modules, plus a change signal that
// refreshes the tray and reports status to the teacher.

import type { StudentMessage } from '../shared/protocol';
import type { StudentConfig } from './config';
import type { TeacherLink } from './connection';

export const state = {
  config: null as StudentConfig | null,
  /** IT supplies the key, so the student's own setup window is never offered. */
  managed: false,
  /** Why the teacher can't be joined: the class key was refused, or versions differ. */
  problem: null as 'key' | 'version' | null,
  teacher: null as { name: string; room: string } | null,
  link: null as TeacherLink | null,
};

export function send(msg: StudentMessage, payload?: Buffer): void {
  state.link?.send(msg, payload);
}

const listeners = new Set<() => void>();

export function onChange(listener: () => void): void {
  listeners.add(listener);
}

/** Something the tray or the teacher's view of this student depends on changed. */
export function changed(): void {
  for (const listener of listeners) listener();
}
