// Who the toolbar actions apply to: the selected students; with nothing
// selected, the group being viewed, or everyone. The view bar always says which.

import type { Target } from '../ipc';
import { $, plural } from './dom';
import * as groups from './groups';
import * as store from './store';

const selected = new Set<string>();
/** Last card clicked, the start point for Shift-click range selection. */
let anchor: string | null = null;
const listeners = new Set<() => void>();

export function onChange(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  for (const id of selected) if (!store.get(id)) selected.delete(id);
  const n = selected.size;
  $('#target-text').textContent = n ? plural(n, 'selected student') : (groups.current()?.name ?? 'everyone');
  $('#select-none').hidden = n === 0;
  document.body.classList.toggle('selecting', n > 0);
  for (const listener of listeners) listener();
}

export const isSelected = (id: string) => selected.has(id);
export const selectedIds = () => [...selected];

export function toggle(id: string): void {
  if (!selected.delete(id)) selected.add(id);
  anchor = id;
  changed();
}

/** Selects every card between the last-clicked card and this one. */
export function extendTo(id: string, ordered: string[]): void {
  const from = anchor ? ordered.indexOf(anchor) : -1;
  const to = ordered.indexOf(id);
  if (from < 0 || to < 0) {
    toggle(id);
    return;
  }
  for (const other of ordered.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(other);
  changed();
}

export function selectAll(ids: string[]): void {
  for (const id of ids) selected.add(id);
  changed();
}

export function clear(): void {
  if (!selected.size) return;
  selected.clear();
  anchor = null;
  changed();
}

/** Re-checks the selection after students are forgotten. */
export function refresh(): void {
  changed();
}

export interface Resolved {
  target: Target;
  /** "everyone" or "3 selected students". */
  label: string;
  /** How many of the targets are connected right now. */
  online: number;
}

export function current(): Resolved {
  const online = (ids: string[]) => ids.filter((id) => store.get(id)?.online).length;
  if (selected.size) {
    const ids = [...selected];
    return { target: { ids, everyone: false }, label: plural(ids.length, 'selected student'), online: online(ids) };
  }
  const group = groups.current();
  if (group) {
    const ids = group.members.filter((id) => store.get(id));
    return { target: { ids, everyone: false }, label: group.name, online: online(ids) };
  }
  const ids = store.all().map((s) => s.id);
  return { target: { ids, everyone: true }, label: 'everyone', online: online(ids) };
}

/** A single student, for actions on one card. */
export function only(id: string): Resolved {
  const s = store.get(id);
  return {
    target: { ids: [id], everyone: false },
    label: s ? store.displayName(s) : 'this student',
    online: s?.online ? 1 : 0,
  };
}
