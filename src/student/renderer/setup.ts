// First-run "Join your class" window.

import type { DiscoveredClass, SetupDetails, SetupStatus, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $('classes');
const searching = $('searching');
const manual = $<HTMLDetailsElement>('manual');
const roomInput = $<HTMLInputElement>('room');
const hostInput = $<HTMLInputElement>('host');
const keyInput = $<HTMLInputElement>('key');
const status = $('status');
const join = $<HTMLButtonElement>('join');

let classes: DiscoveredClass[] = [];
/** Room picked from the discovered list; null means the manual fields are used. */
let selected: string | null = null;

function renderClasses(): void {
  if (selected && !manual.open && !classes.some((c) => c.room === selected) && classes.length) selected = null;
  const usable = classes.filter((c) => c.compatible);
  if (!selected && !manual.open && usable.length === 1) selected = usable[0].room;

  list.replaceChildren(
    ...classes.map((c) => {
      const option = document.createElement('label');
      option.className = 'option';
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'class', value: c.room });
      radio.checked = c.room === selected && !manual.open;
      radio.disabled = !c.compatible;
      radio.addEventListener('change', () => {
        selected = c.room;
        manual.open = false;
      });
      const room = Object.assign(document.createElement('span'), { className: 'room', textContent: c.room });
      const meta = c.compatible ? `${c.teacher} · ${c.host}` : `${c.teacher} · different ClassMonitor version, update needed`;
      const teacher = Object.assign(document.createElement('span'), { className: 'teacher', textContent: meta });
      option.classList.toggle('incompatible', !c.compatible);
      option.append(radio, room, teacher);
      return option;
    }),
  );
  searching.hidden = classes.length > 0;
}

function showStatus(kind: 'progress' | 'ok' | 'error', text: string): void {
  status.className = `status ${kind}`;
  status.textContent = text;
  status.hidden = false;
}

function details(): SetupDetails {
  const classKey = keyInput.value.trim();
  if (selected && !manual.open) return { room: selected, classKey };
  return { room: roomInput.value.trim(), classKey, teacherHost: hostInput.value.trim() };
}

manual.addEventListener('toggle', () => {
  if (manual.open) {
    selected = null;
    roomInput.focus();
  }
  renderClasses();
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!keyInput.value.trim()) {
    showStatus('error', 'Enter the class key from your teacher.');
    keyInput.focus();
    return;
  }
  join.disabled = true;
  try {
    await api.setupJoin(details());
  } catch (err) {
    showStatus('error', (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    join.disabled = false;
  }
});

$('later').addEventListener('click', () => api.setupClose());
keyInput.addEventListener('input', () => {
  if (status.classList.contains('error')) status.hidden = true;
});

api.onSetupClasses((next) => {
  classes = next;
  renderClasses();
});

api.onSetupStatus((s: SetupStatus) => {
  switch (s.state) {
    case 'connecting':
      showStatus('progress', `Connecting to ${s.room}…`);
      break;
    case 'connected':
      showStatus('ok', `You've joined ${s.room}. ${s.teacher} is connected.`);
      break;
    case 'rejected':
      showStatus('error', "Your teacher's computer didn't accept that class key. Check it and try again.");
      join.disabled = false;
      keyInput.select();
      break;
    case 'waiting':
      showStatus(
        'progress',
        `Saved. No teacher has answered for ${s.room} yet. This computer joins automatically when your teacher opens ClassMonitor.`,
      );
      join.disabled = false;
      break;
  }
});

void api.setupInitial().then((initial) => {
  document.body.classList.add(initial.platform);
  keyInput.value = initial.classKey;
  roomInput.value = initial.room;
  hostInput.value = initial.teacherHost;
  if (initial.teacherHost) manual.open = true;
  else if (initial.room) selected = initial.room;
  renderClasses();
  keyInput.focus();
});
