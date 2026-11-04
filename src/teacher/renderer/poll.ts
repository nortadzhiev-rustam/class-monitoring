// Quick polls: ask the targets a question and watch answers come in.

import type { Poll } from '../../shared/protocol';
import { $, api, errorText, plural } from './dom';
import * as panel from './panel';
import * as store from './store';
import type { Resolved } from './targets';

interface Running {
  poll: Poll;
  to: Resolved;
  answers: Map<string, number>;
  ended: boolean;
}

let running: Running | null = null;
let pendingTarget: Resolved | null = null;
/** Opens the dialog aimed at whoever is targeted right now. */
let newPoll: () => void = () => {};

const dialog = $<HTMLDialogElement>('#poll-dialog');
const question = $<HTMLInputElement>('#poll-text');
const choiceList = $('#poll-choices');

export function init(options: { newPoll: () => void }): void {
  newPoll = options.newPoll;
  $('#poll-new').addEventListener('click', () => newPoll());
  store.onChange(() => running && render());
  $('#poll-end').addEventListener('click', end);
  $('#poll-copy').addEventListener('click', () => running && api.copy(summary(running)));
  for (const preset of $('#poll-presets').querySelectorAll<HTMLElement>('[data-preset]')) {
    preset.addEventListener('click', () => setChoices(preset.dataset.preset!.split('|')));
  }
  $('#poll-add').addEventListener('click', () => {
    if (choiceInputs().length < 6) addChoice('').focus();
  });
  $('#poll-form').addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'start') return;
    e.preventDefault();
    void start();
  });
  render();
}

export function openDialog(to: Resolved): void {
  pendingTarget = to;
  $('#poll-title').textContent = to.target.everyone ? 'Poll everyone' : `Poll ${to.label}`;
  $('#poll-error').hidden = true;
  question.value = '';
  setChoices(['Yes', 'No']);
  dialog.returnValue = '';
  dialog.showModal();
  question.focus();
}

const choiceInputs = () => [...choiceList.querySelectorAll<HTMLInputElement>('input')];

function addChoice(value: string): HTMLInputElement {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'choice-row';
  const input = Object.assign(document.createElement('input'), { value, maxLength: 60, placeholder: 'Answer' });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'btn icon-only small', title: 'Remove answer', textContent: '×' });
  remove.addEventListener('click', () => choiceInputs().length > 2 && li.remove());
  row.append(input, remove);
  li.append(row);
  choiceList.append(li);
  return input;
}

function setChoices(values: string[]): void {
  choiceList.replaceChildren();
  for (const value of values) addChoice(value);
}

async function start(): Promise<void> {
  if (!pendingTarget) return;
  const to = pendingTarget;
  try {
    const choices = choiceInputs().map((i) => i.value.trim()).filter(Boolean);
    const poll = await api.pollStart(to.target, question.value, choices);
    clearCardAnswers();
    running = { poll, to, answers: new Map(), ended: false };
    dialog.close();
    panel.open('poll');
    render();
  } catch (err) {
    const el = $('#poll-error');
    el.textContent = errorText(err);
    el.hidden = false;
  }
}

export function receive(id: string, pollId: string, choice: number): void {
  if (!running || running.ended || running.poll.pollId !== pollId) return;
  running.answers.set(id, choice);
  store.patch(id, { answer: running.poll.choices[choice] ?? null });
  render();
}

function end(): void {
  if (!running) return;
  if (!running.ended) {
    api.pollEnd();
    running.ended = true;
    clearCardAnswers();
    render();
  } else {
    newPoll();
  }
}

function clearCardAnswers(): void {
  for (const id of running?.answers.keys() ?? []) store.patch(id, { answer: null });
}

/** Students the poll went to who are online now. */
function expected(r: Running): number {
  const ids = r.to.target.everyone ? store.all().map((s) => s.id) : r.to.target.ids;
  return ids.filter((id) => store.get(id)?.online || r.answers.has(id)).length;
}

function names(r: Running, choice: number): string[] {
  return [...r.answers]
    .filter(([, c]) => c === choice)
    .map(([id]) => store.get(id))
    .filter((s) => s !== undefined)
    .map((s) => store.displayName(s));
}

function summary(r: Running): string {
  const rows = r.poll.choices.map((c, i) => `${c}: ${names(r, i).length}${names(r, i).length ? ` (${names(r, i).join(', ')})` : ''}`);
  return [r.poll.question, ...rows, `${r.answers.size} of ${expected(r)} answered`].join('\n');
}

function render(): void {
  $('#poll-results').hidden = !running;
  $('#poll-empty').hidden = !!running;
  panel.setCount('poll', 0);
  if (!running) return;
  const r = running;
  const total = r.answers.size;
  $('#poll-state').textContent = r.ended ? 'Poll ended' : `Live · ${r.to.label}`;
  $('#poll-question').textContent = r.poll.question;
  $('#poll-count').textContent = `${total} of ${plural(expected(r), 'student')} answered`;
  $('#poll-end').textContent = r.ended ? 'New poll' : 'End poll';
  $('#poll-bars').replaceChildren(
    ...r.poll.choices.map((choice, i) => {
      const who = names(r, i);
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      row.append(
        Object.assign(document.createElement('span'), { className: 'label', textContent: choice }),
        Object.assign(document.createElement('span'), { className: 'n', textContent: total ? `${who.length} · ${Math.round((who.length / total) * 100)}%` : '0' }),
      );
      const track = Object.assign(document.createElement('div'), { className: 'track' });
      const fill = Object.assign(document.createElement('div'), { className: 'fill' });
      fill.style.width = `${total ? (who.length / total) * 100 : 0}%`;
      track.append(fill);
      li.append(row, track);
      if (who.length) li.append(Object.assign(document.createElement('span'), { className: 'names', textContent: who.join(', ') }));
      return li;
    }),
  );
}
