// Student groups: named sets of students shown as chips above the grid.
// Picking a group shows only its members, and with nothing selected the
// toolbar acts on that group.

import type { Group } from '../ipc';
import { $, api, errorText, toast } from './dom';
import * as store from './store';

let groups: Group[] = [];
/** 'all' or a group id. */
let view = 'all';
const listeners = new Set<() => void>();
let handlers: { create(): void; menu(group: Group, at: HTMLElement | { x: number; y: number }): void };

export function onChange(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  render();
  for (const listener of listeners) listener();
}

export function init(options: typeof handlers): void {
  handlers = options;
  store.onChange(render);
}

export function load(next: Group[]): void {
  groups = next;
  if (view !== 'all' && !groups.some((g) => g.id === view)) view = 'all';
  changed();
}

export const list = () => groups;

/** The group being viewed, or null for all students. */
export function current(): Group | null {
  return groups.find((g) => g.id === view) ?? null;
}

export function inView(id: string): boolean {
  const group = current();
  return !group || group.members.includes(id);
}

export function setView(id: string): void {
  view = id;
  changed();
}

async function save(next: Group[]): Promise<void> {
  try {
    groups = await api.saveGroups(next);
    if (view !== 'all' && !groups.some((g) => g.id === view)) view = 'all';
    changed();
  } catch (err) {
    toast(errorText(err));
  }
}

export async function create(name: string, members: string[]): Promise<void> {
  const id = crypto.randomUUID();
  await save([...groups, { id, name, members }]);
  setView(id);
}

export const rename = (id: string, name: string) => save(groups.map((g) => (g.id === id ? { ...g, name } : g)));
export const remove = (id: string) => save(groups.filter((g) => g.id !== id));

export function addMembers(id: string, ids: string[]): Promise<void> {
  return save(groups.map((g) => (g.id === id ? { ...g, members: [...new Set([...g.members, ...ids])] } : g)));
}

export function removeMembers(id: string, ids: string[]): Promise<void> {
  return save(groups.map((g) => (g.id === id ? { ...g, members: g.members.filter((m) => !ids.includes(m)) } : g)));
}

function chip(label: string, count: string, active: boolean): HTMLButtonElement {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: active ? 'view-chip active' : 'view-chip' });
  button.append(label, ' ', Object.assign(document.createElement('span'), { className: 'n', textContent: count }));
  return button;
}

function render(): void {
  const everyone = store.all();
  const all = chip('All students', String(everyone.length), view === 'all');
  all.addEventListener('click', () => setView('all'));

  const chips = groups.map((g) => {
    const members = g.members.filter((id) => store.get(id));
    const online = members.filter((id) => store.get(id)?.online).length;
    const button = chip(g.name, `${online}/${members.length}`, view === g.id);
    button.dataset.group = g.id;
    button.title = 'Click again or right-click for options';
    button.addEventListener('click', () => (view === g.id ? handlers.menu(g, button) : setView(g.id)));
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      handlers.menu(g, { x: e.clientX, y: e.clientY });
    });
    return button;
  });

  const add = Object.assign(document.createElement('button'), { type: 'button', className: 'view-chip add', textContent: '+ Group' });
  add.title = 'Make a group from the selected students';
  add.addEventListener('click', () => handlers.create());
  $('#views').replaceChildren(all, ...chips, add);
}
