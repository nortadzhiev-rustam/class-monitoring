// Files tab: files handed out (with delivery progress) and work being collected.

import type { Transfer } from '../ipc';
import { askText } from './dialogs';
import { $, api, errorText, plural, toast } from './dom';
import * as panel from './panel';
import * as store from './store';
import type { Resolved } from './targets';

interface Batch {
  batchId: string;
  files: string[];
  students: number;
  transfers: Map<string, Transfer>;
}

interface Collection {
  collectId: string;
  title: string;
  folder: string;
  to: Resolved;
  received: Map<string, string[]>;
  ended: boolean;
}

const batches: Batch[] = [];
let collection: Collection | null = null;
let current: () => Resolved = () => {
  throw new Error('handouts not initialised');
};

export function init(options: { current: () => Resolved }): void {
  current = options.current;
  $('#files-send').addEventListener('click', () => void send(current()));
  $('#files-collect').addEventListener('click', () => void collect(current()));
  $('#collect-folder').addEventListener('click', () => collection && api.openFolder(collection.folder));
  $('#collect-end').addEventListener('click', () => {
    if (!collection) return;
    if (collection.ended) void collect(current());
    else {
      api.collectEnd();
      collection.ended = true;
      render();
    }
  });
  store.onChange(() => render());
  render();
}

export async function send(to: Resolved): Promise<void> {
  try {
    const result = await api.sendFiles(to.target);
    if (!result) return;
    if (!result.students) {
      toast('Nobody you picked is online, so nothing was sent.');
      return;
    }
    batches.unshift({ batchId: result.batchId, files: result.files, students: result.students, transfers: new Map() });
    panel.open('files');
    render();
  } catch (err) {
    toast(errorText(err));
  }
}

export async function collect(to: Resolved): Promise<void> {
  const title = await askText(
    to.target.everyone ? 'Collect work from everyone' : `Collect work from ${to.label}`,
    'What are you collecting? (Names the folder the files go into.)',
    'Classwork',
    'Start collecting',
  );
  if (!title) return;
  try {
    const started = await api.collectStart(to.target, title);
    collection = { ...started, to, received: new Map(), ended: false };
    panel.open('files');
    render();
  } catch (err) {
    toast(errorText(err));
  }
}

export function transfer(t: Transfer): void {
  const batch = batches.find((b) => b.batchId === t.batchId);
  if (!batch) return;
  batch.transfers.set(t.transferId, t);
  render();
}

export function collected(id: string, collectId: string, name: string): void {
  if (!collection || collection.collectId !== collectId) return;
  collection.received.set(id, [...(collection.received.get(id) ?? []), name]);
  render();
}

function el(tag: string, className: string, text: string): HTMLElement {
  return Object.assign(document.createElement(tag), { className, textContent: text });
}

function render(): void {
  $('#files-empty').hidden = batches.length > 0 || !!collection;
  $('#collect-results').hidden = !collection;

  if (collection) {
    const c = collection;
    const ids = c.to.target.everyone ? store.all().map((s) => s.id) : c.to.target.ids.filter((id) => store.get(id));
    const expected = [...new Set([...ids, ...c.received.keys()])];
    $('#collect-state').textContent = c.ended ? 'Collection stopped' : `Collecting · ${c.to.label}`;
    $('#collect-title').textContent = c.title;
    $('#collect-count').textContent = `${c.received.size} of ${plural(expected.length, 'student')} handed in`;
    $('#collect-end').textContent = c.ended ? 'Collect again' : 'Stop collecting';
    const handedIn = expected.filter((id) => c.received.has(id));
    const waiting = expected.filter((id) => !c.received.has(id));
    $('#collect-list').replaceChildren(
      ...handedIn.map((id) => {
        const li = el('li', '', '');
        const s = store.get(id);
        li.append(el('span', 'who-name', s ? store.displayName(s) : 'Student'), el('span', 'detail', c.received.get(id)!.join(', ')));
        return li;
      }),
      ...waiting.map((id) => {
        const li = el('li', 'missing', '');
        const s = store.get(id);
        li.append(el('span', 'who-name', s ? store.displayName(s) : 'Student'), el('span', 'detail', s?.online ? 'Not handed in yet' : 'Offline'));
        return li;
      }),
    );
  }

  $('#batches').replaceChildren(
    ...batches.map((b) => {
      const all = [...b.transfers.values()];
      const expected = b.students * b.files.length;
      const done = all.filter((t) => t.state === 'done').length;
      const failed = all.filter((t) => t.state === 'failed');
      const li = el('li', '', '');
      li.append(el('span', 'names', b.files.join(', ')));
      li.append(el('span', 'detail', done === expected ? `Delivered to ${plural(b.students, 'student')}` : `Sending… ${done} of ${expected} delivered`));
      if (done < expected && !failed.length) {
        const track = el('div', 'track', '');
        const fill = el('div', 'fill', '');
        const bytes = all.reduce((n, t) => n + t.sent, 0);
        const total = all.reduce((n, t) => n + t.size, 0);
        fill.style.width = `${total ? Math.round((bytes / total) * 100) : 0}%`;
        track.append(fill);
        li.append(track);
      }
      for (const t of failed) {
        const s = store.get(t.id);
        li.append(el('span', 'failed', `${t.name} → ${s ? store.displayName(s) : 'a student'}: ${t.error ?? 'failed'}`));
      }
      return li;
    }),
  );
}
