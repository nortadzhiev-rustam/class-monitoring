// What the teacher has switched on, per student. A change aimed at "everyone"
// also becomes the class default, so a computer that has never connected
// before picks it up when it joins.

import { OPEN_POLICY, type Policy } from '../shared/protocol';
import type { Target } from './ipc';

export class PolicyTable {
  private classDefault: Policy = { ...OPEN_POLICY };
  private readonly perStudent = new Map<string, Policy>();

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

  reset(): void {
    this.classDefault = { ...OPEN_POLICY };
    this.perStudent.clear();
  }
}

export function samePolicy(a: Policy, b: Policy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
