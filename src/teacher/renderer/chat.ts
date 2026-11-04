// One-to-one chat with students, in the side panel's Chat tab.

import type { ChatMessage } from '../ipc';
import { $, api, errorText, toast } from './dom';
import * as panel from './panel';
import * as store from './store';

const threads = new Map<string, ChatMessage[]>();
let openId: string | null = null;

const list = $('#chat-list');
const thread = $('#chat-thread');
const lines = $('#chat-lines');
const text = $<HTMLTextAreaElement>('#chat-text');

export function init(): void {
  panel.onShow((tab) => {
    if (tab === 'chat') markRead();
  });
  window.addEventListener('focus', () => panel.isShowing('chat') && markRead());
  store.onChange((id) => {
    if (id === null || threads.has(id)) render();
  });
  $('#chat-back').addEventListener('click', () => {
    openId = null;
    render();
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  render();
}

/** Opens (or starts) the conversation with one student. */
export function openThread(id: string): void {
  if (!threads.has(id)) threads.set(id, []);
  openId = id;
  panel.open('chat');
  render();
  text.focus();
}

export function receive(id: string, message: ChatMessage): void {
  const messages = threads.get(id) ?? [];
  messages.push(message);
  threads.set(id, messages);
  const reading = openId === id && panel.isShowing('chat') && document.hasFocus();
  if (!reading) {
    store.patch(id, { unread: (store.get(id)?.unread ?? 0) + 1 });
    const s = store.get(id);
    api.attention(`Message from ${s ? store.displayName(s) : 'a student'}`, message.text);
    if (!panel.isOpen()) openThread(id);
  }
  render();
}

async function send(): Promise<void> {
  const body = text.value.trim();
  if (!openId || !body) return;
  const id = openId;
  try {
    const message = await api.chat(id, body);
    threads.get(id)?.push(message);
    text.value = '';
    render();
  } catch (err) {
    toast(errorText(err));
  }
}

function markRead(): void {
  if (openId && store.get(openId)?.unread) store.patch(openId, { unread: 0 });
}

function line(message: ChatMessage): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `line ${message.from}`;
  const time = document.createElement('time');
  time.textContent = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.append(Object.assign(document.createElement('div'), { className: 'bubble', textContent: message.text }), time);
  return wrap;
}

function render(): void {
  const ids = [...threads.keys()].filter((id) => store.get(id));
  panel.setCount('chat', ids.reduce((n, id) => n + (store.get(id)?.unread ?? 0), 0));

  if (openId && store.get(openId)) {
    const s = store.get(openId)!;
    thread.hidden = false;
    list.hidden = true;
    $('#chat-empty').hidden = true;
    $('#chat-with').textContent = `${store.displayName(s)}${s.online ? '' : ' (offline)'}`;
    text.disabled = !s.online;
    lines.replaceChildren(...(threads.get(openId) ?? []).map(line));
    lines.scrollTop = lines.scrollHeight;
    if (panel.isShowing('chat') && document.hasFocus()) markRead();
    return;
  }

  openId = null;
  thread.hidden = true;
  list.hidden = false;
  $('#chat-empty').hidden = ids.length > 0;
  list.replaceChildren(
    ...ids.map((id) => {
      const s = store.get(id)!;
      const last = threads.get(id)!.at(-1);
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      row.append(Object.assign(document.createElement('strong'), { textContent: store.displayName(s) }));
      if (s.unread) row.append(Object.assign(document.createElement('span'), { className: 'count', textContent: String(s.unread) }));
      li.append(row, Object.assign(document.createElement('span'), { className: 'preview', textContent: last?.text ?? 'No messages yet' }));
      li.addEventListener('click', () => openThread(id));
      return li;
    }),
  );
}
