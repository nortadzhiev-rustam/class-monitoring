// Teacher console entry point: wires the modules together and routes events
// from the main process.

import type { TeacherEvent, TeacherState } from '../ipc';
import * as broadcast from './broadcast';
import * as chat from './chat';
import * as dialogs from './dialogs';
import { $, api, errorText, plural, toast } from './dom';
import * as grid from './grid';
import * as help from './help';
import * as poll from './poll';
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

grid.init({
  view: (s, control) => viewer.open(s, control),
  toggleLock,
  forget: (s) => {
    api.forget(s.id);
    store.forget(s.id);
  },
  chat: (s) => chat.openThread(s.id),
});
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
$('#message').addEventListener('click', () => {
  const to = targets.current();
  dialogs.askMessage(to, async (text) => {
    try {
      const sent = await api.message(to.target, text);
      if (sent) toast(`Message sent to ${plural(sent, 'student')}.`, 'info');
      else toast('Nobody you picked is online, so the message was not sent.');
    } catch (err) {
      toast(errorText(err));
    }
  });
});
$('#poll').addEventListener('click', () => poll.openDialog(targets.current()));

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
