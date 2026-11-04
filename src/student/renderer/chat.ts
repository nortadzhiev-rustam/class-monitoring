// Student side of the teacher chat.

import type { ChatLine, StudentApi } from '../ipc';

declare global {
  interface Window {
    student: StudentApi;
  }
}

const api = window.student;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const lines = $('lines');
const text = $<HTMLTextAreaElement>('text');
const send = $<HTMLButtonElement>('send');
const hand = $<HTMLButtonElement>('hand');
let handRaised = false;
let shown = 0;

function line(l: ChatLine): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `line ${l.from}`;
  const bubble = Object.assign(document.createElement('div'), { className: 'bubble', textContent: l.text });
  const time = document.createElement('time');
  time.textContent = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.append(bubble, time);
  return wrap;
}

api.onChat((state) => {
  const connected = state.teacher !== null;
  $('teacher').textContent = state.teacher ?? 'Your teacher';
  $('presence').textContent = connected ? 'Connected' : 'Not connected to your teacher right now';
  document.title = `Chat with ${state.teacher ?? 'your teacher'}`;
  text.disabled = send.disabled = hand.disabled = !connected;

  handRaised = state.handRaised;
  hand.textContent = handRaised ? 'Lower hand' : 'Raise hand';
  hand.setAttribute('aria-pressed', String(handRaised));

  // Only new lines are appended, so scroll position and selection survive.
  if (state.lines.length < shown) {
    lines.querySelectorAll('.line').forEach((n) => n.remove());
    shown = 0;
  }
  for (const l of state.lines.slice(shown)) lines.append(line(l));
  shown = state.lines.length;
  $('empty').hidden = shown > 0;
  lines.scrollTop = lines.scrollHeight;
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = text.value.trim();
  if (!body) return;
  api.chatSend(body);
  text.value = '';
  text.focus();
});

text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
  }
});

hand.addEventListener('click', () => api.setHand(!handRaised));

api.chatReady();
text.focus();
