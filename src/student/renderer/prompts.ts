// Cards in the always-on-top prompt window: messages, polls, raised hand.

import type { PromptCard, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const root = document.getElementById('cards')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Node[]) {
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
  const b = el('button', { type: 'button', className: primary ? 'btn primary' : 'btn', textContent: label });
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
        const b = el('button', { type: 'button', className: 'choice', textContent: choice });
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
  }
}

/** Cards already on screen; only new ones slide in, so updates don't flicker. */
let shown = new Set<string>();

api.onPrompts((cards) => {
  root.replaceChildren(
    ...cards.map((card) => {
      const node = render(card);
      if (!shown.has(card.id)) node.classList.add('enter');
      return node;
    }),
  );
  shown = new Set(cards.map((c) => c.id));
});

new ResizeObserver(() => api.promptsSize(root.getBoundingClientRect().height)).observe(root);
api.promptsReady();
