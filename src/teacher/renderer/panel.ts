// The collapsible side panel with Help, Chat and Poll tabs. It opens itself
// when something needs the teacher's attention.

import { $ } from './dom';

export type TabId = 'help' | 'chat' | 'poll';

const panel = $('#panel');
const counts: Record<TabId, number> = { help: 0, chat: 0, poll: 0 };
let current: TabId = 'help';
const showListeners = new Set<(tab: TabId) => void>();

/** Called whenever a tab becomes visible (e.g. so Chat can mark messages read). */
export function onShow(listener: (tab: TabId) => void): void {
  showListeners.add(listener);
}

export const isShowing = (tab: TabId) => !panel.hidden && current === tab;
export const isOpen = () => !panel.hidden;

export function open(tab: TabId): void {
  panel.hidden = false;
  current = tab;
  for (const button of panel.querySelectorAll<HTMLElement>('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const body of panel.querySelectorAll<HTMLElement>('.tab-body')) body.hidden = body.dataset.tab !== tab;
  for (const listener of showListeners) listener(tab);
}

export function close(): void {
  panel.hidden = true;
}

/** Badge on a tab; Help and Chat counts also show on the toolbar button. */
export function setCount(tab: TabId, n: number): void {
  counts[tab] = n;
  const badge = panel.querySelector<HTMLElement>(`.tab[data-tab="${tab}"] .count`)!;
  badge.textContent = String(n);
  badge.hidden = n === 0;
  const total = counts.help + counts.chat;
  const toolbar = $('#panel-count');
  toolbar.textContent = String(total);
  toolbar.hidden = total === 0;
}

for (const button of panel.querySelectorAll<HTMLElement>('.tab')) {
  button.addEventListener('click', () => open(button.dataset.tab as TabId));
}
$('#panel-close').addEventListener('click', close);
$('#panel-toggle').addEventListener('click', () => (isOpen() ? close() : open(current)));
