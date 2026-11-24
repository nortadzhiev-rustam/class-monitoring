// What the teacher has switched on, per student. A change aimed at "everyone"
// also becomes the class default, so a computer that has never connected
// before picks it up when it joins.
//
// Blocked apps, website rules and muted sound are the teacher's standing
// choices: they are saved (see lasting()) and come back when the console starts
// again, so the teacher doesn't set them up every lesson. Everything else (a
// lock, a poll, a broadcast...) belongs to the moment and starts off.

import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, LIMITS, OPEN_POLICY, type Policy } from '../shared/protocol';
import { cleanRules } from '../shared/web-rules';
import type { Target } from './ipc';

/** The settings kept across restarts of the console. */
export const LASTING = ['apps', 'web', 'mute'] as const satisfies readonly (keyof Policy)[];
export type LastingPolicy = Pick<Policy, (typeof LASTING)[number]>;

/** The lasting settings as saved: the class default, and students who differ from it. */
export interface SavedPolicies {
  everyone: LastingPolicy;
  students: Record<string, LastingPolicy>;
}

const lastingOf = (policy: Policy): LastingPolicy => ({ apps: policy.apps, web: policy.web, mute: policy.mute });

/** Saved settings come from disk: keep only well-formed ones. */
export function cleanLasting(raw: Partial<LastingPolicy> | undefined): LastingPolicy {
  const apps = Array.isArray(raw?.apps)
    ? [...new Set(raw.apps.filter((a): a is string => typeof a === 'string' && APP_NAME.test(a)))].slice(0, LIMITS.blockedApps)
    : [];
  return { apps: apps.length ? apps : null, web: cleanRules(raw?.web ?? null), mute: raw?.mute === true };
}

export class PolicyTable {
  private classDefault: Policy = { ...OPEN_POLICY };
  private readonly perStudent = new Map<string, Policy>();

  constructor(saved?: SavedPolicies) {
    if (!saved) return;
    this.classDefault = { ...OPEN_POLICY, ...cleanLasting(saved.everyone) };
    for (const [id, lasting] of Object.entries(saved.students ?? {}).slice(0, 1000)) {
      if (/^[\w-]{8,64}$/.test(id)) this.perStudent.set(id, { ...OPEN_POLICY, ...cleanLasting(lasting) });
    }
  }

  get(id: string): Policy {
    return this.perStudent.get(id) ?? this.classDefault;
  }

  /** Applies `patch` to the target; returns the ids whose policy changed. */
  apply(target: Target, patch: Partial<Policy>): string[] {
    // Snapshot first: students without their own entry follow the class
    // default, which is about to change.
    const before = this.snapshot(target.ids);
    if (target.everyone) this.classDefault = { ...this.classDefault, ...patch };
    for (const id of target.ids) this.perStudent.set(id, { ...before.get(id)!, ...patch });
    return this.changedSince(before);
  }

  /**
   * Turns one setting off everywhere (e.g. the broadcast ended). `ids` lists
   * students who may only follow the class default, such as everyone online.
   */
  clear<K extends keyof Policy>(key: K, ids: Iterable<string>): string[] {
    const before = this.snapshot([...ids, ...this.perStudent.keys()]);
    this.classDefault = { ...this.classDefault, [key]: OPEN_POLICY[key] };
    for (const [id, policy] of this.perStudent) this.perStudent.set(id, { ...policy, [key]: OPEN_POLICY[key] });
    return this.changedSince(before);
  }

  private snapshot(ids: Iterable<string>): Map<string, Policy> {
    return new Map([...new Set(ids)].map((id) => [id, this.get(id)]));
  }

  private changedSince(before: Map<string, Policy>): string[] {
    return [...before].filter(([id, policy]) => !samePolicy(policy, this.get(id))).map(([id]) => id);
  }

  /** Ends everything of the moment (new class settings), keeping the lasting settings. */
  reset(): void {
    this.classDefault = { ...OPEN_POLICY, ...lastingOf(this.classDefault) };
    for (const [id, policy] of this.perStudent) this.perStudent.set(id, { ...OPEN_POLICY, ...lastingOf(policy) });
  }

  /** A forgotten computer: it starts from the class default if it ever comes back. */
  forget(id: string): void {
    this.perStudent.delete(id);
  }

  /** The lasting settings, to save; students whose settings match the class default follow it. */
  lasting(): SavedPolicies {
    const everyone = lastingOf(this.classDefault);
    const students: Record<string, LastingPolicy> = {};
    for (const [id, policy] of this.perStudent) {
      const own = lastingOf(policy);
      if (JSON.stringify(own) !== JSON.stringify(everyone)) students[id] = own;
    }
    return { everyone, students };
  }
}

/** The saved lasting settings, or none (first run, or an unreadable file). */
export function loadPolicies(file: string): SavedPolicies | undefined {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedPolicies;
    return saved && typeof saved === 'object' ? saved : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[policy] starting without saved settings:', (err as Error).message);
    return undefined;
  }
}

export function savePolicies(file: string, saved: SavedPolicies): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a truncated file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[policy] could not save:', (err as Error).message);
  }
}

export function samePolicy(a: Policy, b: Policy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
