// The toolbar at the top of the student's screen (the window: src/student/toolbar.ts).
// Tucked away it is a small tab; hovering slides the bar out, and it slides
// back a moment after the pointer leaves. Something new (the teacher connects
// or starts watching, work to hand in, a chat message) brings it out briefly.

import type { StudentApi, ToolbarAction, ToolbarState } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const dock = byId('dock');

/** How long the bar stays out after the pointer leaves it, and after something new happens. */
const LINGER_MS = 1200;
const PEEK_MS = 5000;

let previous: ToolbarState | null = null;
/** The pointer is on the bar or its tab (elsewhere, clicks go to the apps below). */
let pointerOver = false;
let closeTimer: number | null = null;

function setOpen(open: boolean): void {
  dock.dataset.open = String(open);
}

function closeAfter(ms: number): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    if (!pointerOver) setOpen(false);
  }, ms);
}

/** Slides the bar out; with `ms`, slides it back after that long unless the pointer is on it. */
function open(ms?: number): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
  setOpen(true);
  if (ms !== undefined) closeAfter(ms);
}

function setPointer(over: boolean): void {
  if (over === pointerOver) return;
  pointerOver = over;
  api.toolbarPointer(over);
  if (over) open();
  else closeAfter(LINGER_MS);
}

// Moves arrive even while the window lets clicks through, so the bar can tell when the pointer reaches it.
document.addEventListener('mousemove', (e) => setPointer((e.target as Element).closest('#bar, #tab') !== null));
document.addEventListener('mouseleave', () => setPointer(false));

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function chip(kind: string, iconName: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `chip ${kind}`;
  el.append(icon(iconName), text);
  return el;
}

/** Worth showing the bar for: the student should notice it. */
function isNews(s: ToolbarState, before: ToolbarState | null): boolean {
  if (!before || before.teacher !== s.teacher) return true;
  return (
    (s.viewing && !before.viewing) ||
    (s.controlled && !before.controlled) ||
    (s.collect !== null && s.collect !== before.collect) ||
    (s.presenting && !before.presenting) ||
    (s.muted && !before.muted) ||
    s.unread > before.unread
  );
}

function render(s: ToolbarState): void {
  byId('teacher').textContent = s.teacher;
  byId('room').textContent = s.room;
  byId('bar').title = `Connected to ${s.teacher} (${s.room})`;

  const hand = byId('hand');
  hand.setAttribute('aria-pressed', String(s.handRaised));
  hand.querySelector('.label')!.textContent = s.handRaised ? 'Lower hand' : 'Raise hand';
  hand.title = s.handRaised ? 'Your teacher can see your hand is up' : 'Ask your teacher for help';

  byId('chat').title = `Chat with ${s.teacher}`;
  const unread = byId('unread');
  unread.hidden = s.unread === 0;
  unread.textContent = s.unread > 9 ? '9+' : String(s.unread);

  const handIn = byId('hand-in');
  handIn.hidden = s.collect === null;
  handIn.title = s.collect ? `Hand in: ${s.collect}` : '';

  document.body.dataset.watch = s.controlled ? 'controlled' : s.viewing ? 'viewing' : '';
  const chips: HTMLElement[] = [];
  if (s.presenting) chips.push(chip('viewing', 'i-screen', 'Shown to the class'));
  if (s.controlled) chips.push(chip('controlled', 'i-pointer', 'Teacher has control'));
  else if (s.viewing && !s.presenting) chips.push(chip('viewing', 'i-eye', 'Teacher is watching'));
  if (s.webLimited) chips.push(chip('limits', 'i-globe', 'Websites limited'));
  if (s.appsBlocked) chips.push(chip('limits', 'i-block', 'Apps blocked'));
  if (s.muted) chips.push(chip('limits', 'i-muted', 'Sound off'));
  byId('chips').replaceChildren(...chips);

  if (isNews(s, previous)) open(PEEK_MS);
  previous = s;
}

for (const action of ['hand', 'chat', 'hand-in'] as const satisfies readonly ToolbarAction[]) {
  byId(action).addEventListener('click', () => api.toolbarAction(action));
}
byId('hide').addEventListener('click', () => {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
  setOpen(false);
  pointerOver = false;
  api.toolbarPointer(false);
});

api.onToolbar(render);
api.toolbarReady();
