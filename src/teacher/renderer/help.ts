// Help queue: students with a raised hand, oldest first.

import { $, api, timeAgo } from './dom';
import * as panel from './panel';
import * as store from './store';
import type { Student } from './store';

const queue = $('#help-queue');
let raised = new Set<string>();
let actions: { view(s: Student): void; chat(s: Student): void };

export function init(handlers: typeof actions): void {
  actions = handlers;
  store.onChange(render);
  setInterval(render, 30_000);
  render();
}

function waiting(): Student[] {
  return store
    .all()
    .filter((s) => s.online && s.status.hand !== null)
    .sort((a, b) => (a.handSince ?? 0) - (b.handSince ?? 0));
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: primary ? 'btn small primary' : 'btn small', textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

function render(): void {
  const list = waiting();
  const now = new Set(list.map((s) => s.id));
  for (const s of list) if (!raised.has(s.id)) announce(s);
  raised = now;

  queue.replaceChildren(
    ...list.map((s) => {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      row.append(
        Object.assign(document.createElement('strong'), { textContent: store.displayName(s) }),
        Object.assign(document.createElement('span'), { className: 'when', textContent: timeAgo(s.handSince ?? Date.now()) }),
      );
      li.append(row);
      if (s.status.hand) li.append(Object.assign(document.createElement('p'), { className: 'note', textContent: s.status.hand }));
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      buttons.append(
        button('View', () => actions.view(s)),
        button('Chat', () => actions.chat(s)),
        button('Done', () => api.handClear(s.id), true),
      );
      li.append(buttons);
      return li;
    }),
  );
  $('#help-empty').hidden = list.length > 0;
  panel.setCount('help', list.length);
}

/** A hand just went up: make sure the teacher notices, even if the console is in the background. */
function announce(s: Student): void {
  api.attention(`${store.displayName(s)} raised their hand`, s.status.hand || undefined);
  if (!panel.isOpen()) panel.open('help');
}
