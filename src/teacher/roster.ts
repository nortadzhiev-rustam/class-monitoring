// Every student computer this console has seen, kept in roster.json so absent
// students still show up (greyed out), and so groups, the card order and
// Wake-on-LAN survive restarts. Groups and the order live here too, since they
// are lists of these ids. The name a student signs in with only lasts while
// their computer is connected: when it disconnects (restart, network, the
// student app or this console closing) the card shows the computer's name again.

import fs from 'node:fs';
import path from 'node:path';
import type { StudentInfo } from '../shared/protocol';
import type { Group, RosterEntry } from './ipc';
import { cleanOrder } from './order';

const SAVE_DELAY_MS = 500;

export class Roster {
  private readonly entries = new Map<string, RosterEntry>();
  private groupList: Group[] = [];
  /** The teacher's arrangement of the cards; empty means name order. */
  private orderList: string[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { students?: RosterEntry[]; groups?: Group[]; order?: string[] };
      // Last lesson's signed-in names don't carry over (see above).
      for (const entry of saved.students ?? []) if (entry?.id) this.entries.set(entry.id, { ...entry, name: undefined });
      this.groupList = cleanGroups(saved.groups ?? []);
      this.orderList = cleanOrder(saved.order);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[roster] starting empty:', (err as Error).message);
    }
  }

  list(): RosterEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): RosterEntry | undefined {
    return this.entries.get(id);
  }

  /** Records a student that just connected and returns its entry. */
  seen(info: StudentInfo, address: string): RosterEntry {
    const entry: RosterEntry = {
      ...this.entries.get(info.id),
      name: undefined,
      id: info.id,
      hostname: info.hostname,
      username: info.username,
      platform: info.platform,
      macs: info.macs,
      address,
      lastSeen: Date.now(),
    };
    this.entries.set(info.id, entry);
    this.scheduleSave();
    return entry;
  }

  left(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastSeen = Date.now();
    entry.name = undefined;
    this.scheduleSave();
  }

  forget(id: string): void {
    if (!this.entries.delete(id)) return;
    for (const group of this.groupList) group.members = group.members.filter((m) => m !== id);
    this.orderList = this.orderList.filter((m) => m !== id);
    this.scheduleSave();
  }

  /** The name the student typed when signing in to a register, until their computer disconnects. */
  setName(id: string, name: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.name = name;
    this.scheduleSave();
  }

  groups(): Group[] {
    return this.groupList.map((g) => ({ ...g, members: [...g.members] }));
  }

  setGroups(groups: Group[]): Group[] {
    this.groupList = cleanGroups(groups);
    this.scheduleSave();
    return this.groups();
  }

  order(): string[] {
    return [...this.orderList];
  }

  /** The cards' order as the teacher dragged them; an empty list goes back to name order. */
  setOrder(ids: string[]): void {
    this.orderList = cleanOrder(ids);
    this.scheduleSave();
  }

  /** Writes pending changes now (on quit). */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write never leaves a truncated roster.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ students: this.list(), groups: this.groupList, order: this.orderList }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[roster] could not save:', (err as Error).message);
    }
  }
}

/** Groups come from the renderer or disk: keep only well-formed ones. */
function cleanGroups(raw: Group[]): Group[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')
    .slice(0, 50)
    .map((g) => ({
      id: g.id.slice(0, 64),
      name: g.name.trim().slice(0, 40) || 'Group',
      members: [...new Set((Array.isArray(g.members) ? g.members : []).filter((m) => typeof m === 'string'))].slice(0, 500),
    }));
}
