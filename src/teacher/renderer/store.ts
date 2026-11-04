// Every student the console knows about: the saved roster merged with live
// connection state. The grid, targets and panels render from here.

import { OPEN_POLICY, type Platform, type Policy } from '../../shared/protocol';
import type { RosterEntry, StudentStatus, StudentSummary } from '../ipc';

export interface Student {
  id: string;
  hostname: string;
  username: string;
  platform: Platform;
  address: string;
  lastSeen: number;
  /** Name the student signed in with, if any. */
  name?: string;
  online: boolean;
  status: StudentStatus;
  policy: Policy;
  /** When the student's hand went up, for ordering the Help queue. */
  handSince: number | null;
  /** Chat messages from this student the teacher hasn't read. */
  unread: number;
  /** The student's answer to the running poll, as shown on the card. */
  answer: string | null;
}

/** Fields the console tracks itself, not reported by the student. */
type Extras = Pick<Student, 'unread' | 'answer'>;

const OFFLINE_STATUS: StudentStatus = { locked: false, viewing: false, controlled: false, hand: null };

const students = new Map<string, Student>();
/** `id` is the student that changed, or null when many did. */
type Listener = (id: string | null) => void;
const listeners = new Set<Listener>();

export function onChange(listener: Listener): void {
  listeners.add(listener);
}

function changed(id: string | null): void {
  for (const listener of listeners) listener(id);
}

export function computerName(s: Pick<Student, 'hostname'>): string {
  return s.hostname.replace(/\.local$/, '');
}

/** The student's signed-in name, or the computer name until they sign in. */
export function displayName(s: Pick<Student, 'hostname' | 'name'>): string {
  return s.name || computerName(s);
}

export function get(id: string): Student | undefined {
  return students.get(id);
}

/** All known students, sorted by name so cards keep their place. */
export function all(): Student[] {
  return [...students.values()].sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
}

function fromEntry(entry: RosterEntry): Student {
  return { ...entry, online: false, status: OFFLINE_STATUS, policy: OPEN_POLICY, handSince: null, unread: 0, answer: null };
}

export function load(roster: RosterEntry[], online: StudentSummary[]): void {
  students.clear();
  for (const entry of roster) students.set(entry.id, fromEntry(entry));
  for (const summary of online) setOnline(summary);
  changed(null);
}

function setOnline(summary: StudentSummary, entry?: RosterEntry): void {
  const { info } = summary;
  const known = students.get(info.id) ?? (entry ? fromEntry(entry) : undefined);
  students.set(info.id, {
    unread: 0,
    answer: null,
    ...known,
    handSince: summary.status.hand === null ? null : (known?.handSince ?? Date.now()),
    id: info.id,
    hostname: info.hostname,
    username: info.username,
    platform: info.platform,
    address: summary.address,
    lastSeen: Date.now(),
    online: true,
    status: summary.status,
    policy: summary.policy,
  });
}

export function joined(summary: StudentSummary, entry: RosterEntry): void {
  setOnline(summary, entry);
  changed(summary.info.id);
}

export function left(id: string): void {
  const s = students.get(id);
  if (!s) return;
  students.set(id, { ...s, online: false, lastSeen: Date.now(), status: OFFLINE_STATUS, handSince: null });
  changed(id);
}

export function setStatus(id: string, status: StudentStatus): void {
  const s = students.get(id);
  if (!s) return;
  const handSince = status.hand === null ? null : (s.handSince ?? Date.now());
  students.set(id, { ...s, status, handSince });
  changed(id);
}

export function patch(id: string, extras: Partial<Extras>): void {
  const s = students.get(id);
  if (!s) return;
  students.set(id, { ...s, ...extras });
  changed(id);
}

export function setName(id: string, name: string): void {
  const s = students.get(id);
  if (!s) return;
  students.set(id, { ...s, name });
  changed(null); // Names decide the card order.
}

export function setPolicy(id: string, policy: Policy): void {
  const s = students.get(id);
  if (!s) return;
  students.set(id, { ...s, policy });
  changed(id);
}

export function forget(id: string): void {
  if (students.delete(id)) changed(null);
}
