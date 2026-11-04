// Teacher console entry point: wires the modules together and routes events
// from the main process.

import type { TeacherEvent, TeacherState } from '../ipc';
import * as broadcast from './broadcast';
import * as chat from './chat';
import * as dialogs from './dialogs';
import { $, api, errorText, plural, toast } from './dom';
import * as grid from './grid';
import * as groups from './groups';
import * as handouts from './handouts';
import * as help from './help';
import { showMenu, type MenuItem } from './menu';
import * as poll from './poll';
import * as register from './register';
import * as store from './store';
import type { Student } from './store';
import * as targets from './targets';
import * as viewer from './viewer';

let state: TeacherState;

function toggleLock(s: Student): void {
  const one = targets.only(s.id);
  if (s.policy.lock !== null) api.unlock(one.target);
  else dialogs.askLock(one, (message) => api.lock(one.target, message));
}

function forget(s: Student): void {
  api.forget(s.id);
  store.forget(s.id);
}

function sendMessage(to: targets.Resolved): void {
  dialogs.askMessage(to, async (text) => {
    try {
      const sent = await api.message(to.target, text);
      if (sent) toast(`Message sent to ${plural(sent, 'student')}.`, 'info');
      else toast('Nobody you picked is online, so the message was not sent.');
    } catch (err) {
      toast(errorText(err));
    }
  });
}

async function createGroup(members: string[]): Promise<void> {
  const name = await dialogs.askText(
    'New group',
    members.length ? `Name for a group of ${plural(members.length, 'student')}` : 'Name (add students to it from their ⋯ menu)',
    `Group ${groups.list().length + 1}`,
    'Create group',
  );
  if (!name) return;
  await groups.create(name, members);
  targets.clear();
}

/** A card's ⋯ / right-click menu. Group actions apply to the whole selection if this card is in it. */
function cardMenu(s: Student, at: HTMLElement | { x: number; y: number }): void {
  const ids = targets.isSelected(s.id) && targets.selectedIds().length > 1 ? targets.selectedIds() : [s.id];
  const who = ids.length > 1 ? plural(ids.length, 'selected student') : store.displayName(s);
  const items: MenuItem[] = [];
  if (s.online) {
    items.push(
      { label: 'View screen', action: () => viewer.open(s, false) },
      { label: 'Chat', action: () => chat.openThread(s.id) },
      { label: 'Send message…', action: () => sendMessage(targets.only(s.id)) },
      'separator',
    );
  }
  for (const g of groups.list()) {
    const inGroup = ids.every((id) => g.members.includes(id));
    items.push({
      label: inGroup ? `Remove ${who} from ${g.name}` : `Add ${who} to ${g.name}`,
      action: () => void (inGroup ? groups.removeMembers(g.id, ids) : groups.addMembers(g.id, ids)),
    });
  }
  items.push({ label: `New group with ${who}…`, action: () => void createGroup(ids) });
  if (!s.online) items.push('separator', { label: 'Forget this computer', danger: true, action: () => forget(s) });
  showMenu(at, items);
}

function groupMenu(g: { id: string; name: string; members: string[] }, at: HTMLElement | { x: number; y: number }): void {
  const picked = targets.selectedIds();
  const inGroup = picked.filter((id) => g.members.includes(id));
  showMenu(at, [
    { label: picked.length ? `Add ${plural(picked.length, 'selected student')}` : 'Add selected students', disabled: !picked.length, action: () => void groups.addMembers(g.id, picked) },
    { label: inGroup.length ? `Remove ${plural(inGroup.length, 'selected student')}` : 'Remove selected students', disabled: !inGroup.length, action: () => void groups.removeMembers(g.id, inGroup) },
    {
      label: 'Rename…',
      action: async () => {
        const name = await dialogs.askText('Rename group', 'Group name', g.name, 'Rename');
        if (name) await groups.rename(g.id, name);
      },
    },
    'separator',
    { label: `Delete ${g.name}`, danger: true, action: () => void groups.remove(g.id) },
  ]);
}

grid.init({
  view: (s, control) => viewer.open(s, control),
  toggleLock,
  forget,
  chat: (s) => chat.openThread(s.id),
  menu: cardMenu,
});
groups.init({ create: () => void createGroup(targets.selectedIds()), menu: groupMenu });
register.init({ newRegister: () => void register.start(targets.current()) });
handouts.init({ current: targets.current });
viewer.init({ toggleLock, dialogOpen: dialogs.anyOpen });
help.init({ view: (s) => viewer.open(s, false), chat: (s) => chat.openThread(s.id) });
chat.init();
poll.init({ newPoll: () => poll.openDialog(targets.current()) });

// ---------------------------------------------------------------- toolbar

$('#lock').addEventListener('click', () => {
  const to = targets.current();
  dialogs.askLock(to, (message) => api.lock(to.target, message));
});
$('#unlock').addEventListener('click', () => api.unlock(targets.current().target));
$('#broadcast').addEventListener('click', () => (broadcast.active() ? broadcast.stop() : void broadcast.start(targets.current())));
$('#message').addEventListener('click', () => sendMessage(targets.current()));
$('#poll').addEventListener('click', () => poll.openDialog(targets.current()));
$('#register').addEventListener('click', () => void register.start(targets.current()));
$('#files').addEventListener('click', () =>
  showMenu($('#files'), [
    { label: 'Send files…', action: () => void handouts.send(targets.current()) },
    { label: 'Collect work…', action: () => void handouts.collect(targets.current()) },
  ]),
);

$('#select-all').addEventListener('click', () => targets.selectAll(grid.visibleIds()));
$('#select-none').addEventListener('click', () => targets.clear());

document.addEventListener('keydown', (e) => {
  if (dialogs.anyOpen() || viewer.viewingId() || (e.target as HTMLElement).closest('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    targets.selectAll(grid.visibleIds());
  } else if (e.key === 'Escape') {
    targets.clear();
  }
});

// ---------------------------------------------------------------- settings

dialogs.initSettings({
  beforeSave: () => {
    viewer.close();
    broadcast.stop();
  },
  saved: (next) => applyState(next),
});
for (const id of ['#settings', '#room', '#empty-settings']) $(id).addEventListener('click', () => dialogs.openSettings(state));

// ---------------------------------------------------------------- events

function applyState(next: TeacherState): void {
  state = next;
  $('#room-name').textContent = state.settings.room;
  $('#empty-room').textContent = state.settings.room;
  $('#empty-key').textContent = state.settings.classKey;
  store.load(state.roster, state.students);
  groups.load(state.groups);
}

/** Warn once per address, not on every reconnect attempt. */
const versionWarned = new Set<string>();

api.onEvent((event: TeacherEvent) => {
  switch (event.type) {
    case 'joined':
      store.joined(event.student, event.entry);
      break;
    case 'left':
      store.left(event.id);
      broadcast.studentLeft(event.id);
      viewer.studentLeft(event.id);
      break;
    case 'status':
      store.setStatus(event.id, event.status);
      break;
    case 'policy':
      store.setPolicy(event.id, event.policy);
      break;
    case 'thumb':
      grid.showThumb(event.id, event.jpeg);
      break;
    case 'signal':
      if (!viewer.handleSignal(event.sessionId, event.signal)) broadcast.handleSignal(event.id, event.sessionId, event.signal);
      break;
    case 'broadcast-ready':
      broadcast.connect(event.id, event.sessionId);
      break;
    case 'student-error': {
      const s = store.get(event.id);
      toast(`${s ? store.displayName(s) : 'A student computer'}: ${event.message}`);
      viewer.sessionFailed(event.sessionId);
      break;
    }
    case 'chat':
      chat.receive(event.id, event.message);
      break;
    case 'poll-answer':
      poll.receive(event.id, event.pollId, event.choice);
      break;
    case 'sign-in':
      register.signIn(event.id, event.registerId, event.name);
      break;
    case 'transfer':
      handouts.transfer(event.transfer);
      break;
    case 'collected':
      handouts.collected(event.id, event.collectId, event.name);
      break;
    case 'version-mismatch':
      if (versionWarned.has(event.address)) break;
      versionWarned.add(event.address);
      toast(`The computer at ${event.address} runs a different version of ClassMonitor. Update it so both match.`);
      break;
  }
});

void api.state().then((initial) => {
  document.body.classList.add(initial.platform);
  broadcast.init(initial.platform);
  applyState(initial);
});
