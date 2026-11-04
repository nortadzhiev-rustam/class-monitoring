// Cards in the always-on-top prompt window: messages, polls, raised hand,
// register sign-in, received files and work to hand in.

import type { PromptCard, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const root = document.getElementById('cards')!;

function el(tag: string, props: { className?: string; textContent?: string } = {}, ...children: Node[]): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function header(title: string, at?: number): HTMLElement {
  const head = el('header', {}, el('span', { className: 'badge-dot' }), el('span', { textContent: title }));
  if (at) head.append(el('span', { className: 'time', textContent: time(at) }));
  return head;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: primary ? 'btn primary' : 'btn', textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

function render(card: PromptCard): HTMLElement {
  switch (card.kind) {
    case 'message':
      return el(
        'article',
        { className: 'card message' },
        header(`Message from ${card.from}`, card.at),
        el('p', { className: 'text', textContent: card.text }),
        el('footer', {}, button('OK', () => api.promptAction(card.id, 'dismiss'), true)),
      );
    case 'poll': {
      const long = card.choices.some((c) => c.length > 14);
      const choices = el('div', { className: long ? 'choices long' : 'choices' });
      card.choices.forEach((choice, i) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'choice', textContent: choice });
        b.setAttribute('aria-pressed', String(card.answer === i));
        b.addEventListener('click', () => api.promptAction(card.id, 'answer', i));
        choices.append(b);
      });
      return el(
        'article',
        { className: 'card poll' },
        header(`Quick poll from ${card.from}`),
        el('p', { className: 'question', textContent: card.question }),
        choices,
        el('p', {
          className: 'hint',
          textContent: card.answer === null ? 'Pick one. You can change it until the poll ends.' : 'Answer sent. You can still change it.',
        }),
      );
    }
    case 'hand':
      return el(
        'article',
        { className: 'card hand' },
        header('Your hand is raised'),
        el('p', { className: 'hint', textContent: 'Your teacher has been told you need help.' }),
        el('footer', {}, button('Lower hand', () => api.promptAction(card.id, 'lower'))),
      );
    case 'sign-in': {
      if (card.done) {
        return el(
          'article',
          { className: 'card sign-in done' },
          header(`Register from ${card.from}`),
          el('p', { className: 'text', textContent: `✓ Signed in as ${card.name}` }),
        );
      }
      const input = Object.assign(document.createElement('input'), { className: 'name', value: card.name, maxLength: 60, placeholder: 'Your full name' });
      input.autocomplete = 'name';
      input.dataset.keep = card.id;
      const submit = () => api.promptAction(card.id, 'submit', input.value);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      const node = el(
        'article',
        { className: 'card sign-in' },
        header(`Register from ${card.from}`),
        el('label', { className: 'question', textContent: 'Sign in with your name' }),
        input,
      );
      if (card.error) node.append(el('p', { className: 'hint error', textContent: card.error }));
      node.append(el('footer', {}, button('Sign in', submit, true)));
      return node;
    }
    case 'file':
      return el(
        'article',
        { className: 'card file' },
        header(`File from ${card.from}`),
        el('p', { className: 'text file-name', textContent: card.name }),
        el('p', { className: 'hint', textContent: 'Saved in Documents › ClassMonitor › From teacher' }),
        el(
          'footer',
          {},
          button('Done', () => api.promptAction(card.id, 'dismiss')),
          button('Show in folder', () => api.promptAction(card.id, 'folder')),
          button('Open', () => api.promptAction(card.id, 'open'), true),
        ),
      );
    case 'notice':
      return el(
        'article',
        { className: 'card notice' },
        header(card.title),
        el('p', { className: 'hint', textContent: card.text }),
        el('footer', {}, button('OK', () => api.promptAction(card.id, 'dismiss'))),
      );
    case 'power': {
      const verb = { logoff: 'log you off', restart: 'restart this computer', shutdown: 'shut down this computer' }[card.action];
      const count = el('p', { className: 'countdown', textContent: '' });
      count.dataset.deadline = String(card.deadline);
      tick(count);
      return el(
        'article',
        { className: 'card power' },
        header(`Your teacher will ${verb}`),
        count,
        el('p', { className: 'hint', textContent: 'Save your work now.' }),
      );
    }
    case 'collect': {
      const node = el('article', { className: 'card collect' }, header(`Hand in work for ${card.from}`), el('p', { className: 'question', textContent: card.title }));
      const items = el('ul', { className: 'files' });
      for (const name of card.handedIn) items.append(el('li', { className: 'ok', textContent: `✓ ${name}` }));
      for (const name of card.sending) items.append(el('li', { textContent: `Sending ${name}…` }));
      if (items.childElementCount) node.append(items);
      node.append(
        el('p', {
          className: card.error ? 'hint error' : 'hint',
          textContent: card.error ?? (card.handedIn.length ? 'Handed in. You can add more files.' : 'Choose the files to hand in.'),
        }),
        el('footer', {}, button(card.handedIn.length ? 'Add more files…' : 'Choose files…', () => api.promptAction(card.id, 'choose'), true)),
      );
      return node;
    }
  }
}

function tick(node: HTMLElement): void {
  const seconds = Math.max(0, Math.ceil((Number(node.dataset.deadline) - Date.now()) / 1000));
  node.textContent = seconds ? `in ${seconds} second${seconds === 1 ? '' : 's'}` : 'now';
}
setInterval(() => root.querySelectorAll<HTMLElement>('.countdown').forEach(tick), 250);

/** Cards already on screen; only new ones slide in, so updates don't flicker. */
let shown = new Set<string>();

api.onPrompts((cards) => {
  // Keep whatever the student is typing (and the cursor) across re-renders.
  const typed = new Map<string, string>();
  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-keep]')) typed.set(input.dataset.keep!, input.value);
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;

  root.replaceChildren(
    ...cards.map((card) => {
      const node = render(card);
      if (!shown.has(card.id)) node.classList.add('enter');
      return node;
    }),
  );
  shown = new Set(cards.map((c) => c.id));

  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-keep]')) {
    const value = typed.get(input.dataset.keep!);
    if (value !== undefined) input.value = value;
    if (input.dataset.keep === focused) input.focus();
  }
});

new ResizeObserver(() => api.promptsSize(root.getBoundingClientRect().height)).observe(root);
api.promptsReady();
