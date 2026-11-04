// The grid of student cards: thumbnails, status, selection and per-card actions.

import { $, OS_LABEL, plural, timeAgo } from './dom';
import * as groups from './groups';
import * as store from './store';
import type { Student } from './store';
import * as targets from './targets';

export interface CardActions {
  view(s: Student, control: boolean): void;
  toggleLock(s: Student): void;
  forget(s: Student): void;
  chat(s: Student): void;
  menu(s: Student, at: HTMLElement | { x: number; y: number }): void;
}

interface Card {
  el: HTMLElement;
  img: HTMLImageElement;
  thumbUrl: string | null;
}

const cards = new Map<string, Card>();
const grid = $('#grid');
const cardTemplate = $<HTMLTemplateElement>('#card-template');
const showOfflineInput = $<HTMLInputElement>('#show-offline');
let actions: CardActions;

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the preference just isn't remembered.
  }
};

export function init(cardActions: CardActions): void {
  actions = cardActions;
  store.onChange((id) => (id ? renderCard(id) : renderAll()));
  groups.onChange(() => {
    renderAll();
    targets.refresh();
  });
  targets.onChange(() => {
    for (const [id, card] of cards) card.el.classList.toggle('selected', targets.isSelected(id));
  });

  showOfflineInput.checked = remembered('showOffline') !== 'false';
  showOfflineInput.addEventListener('change', () => {
    remember('showOffline', String(showOfflineInput.checked));
    renderAll();
  });

  const zoom = $<HTMLInputElement>('#zoom');
  const applyZoom = () => {
    document.documentElement.style.setProperty('--card-min', `${zoom.value}px`);
    remember('zoom', zoom.value);
  };
  zoom.value = remembered('zoom') ?? zoom.value;
  zoom.addEventListener('input', applyZoom);
  applyZoom();

  // Offline cards say how long ago each computer was seen; keep that fresh.
  setInterval(() => {
    for (const s of store.all()) if (!s.online) renderCard(s.id);
  }, 60_000);
}

const visible = (s: Student) => groups.inView(s.id) && (s.online || showOfflineInput.checked);

/** Ids of the cards on screen, in display order (for Shift-click ranges and Select all). */
export function visibleIds(): string[] {
  return store.all().filter(visible).map((s) => s.id);
}

function createCard(id: string): Card {
  const el = (cardTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.dataset.id = id;
  el.addEventListener('click', (e) => {
    const s = store.get(id);
    if (!s) return;
    const clicked = e.target as HTMLElement;
    if (clicked.closest('.select') || e.metaKey || e.ctrlKey) {
      targets.toggle(id);
      return;
    }
    if (e.shiftKey) {
      targets.extendTo(id, visibleIds());
      return;
    }
    const action = clicked.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'lock') actions.toggleLock(s);
    else if (action === 'forget') actions.forget(s);
    else if (action === 'chat') actions.chat(s);
    else if (action === 'more') actions.menu(s, clicked.closest<HTMLElement>('[data-action]')!);
    else if (s.online && clicked.closest('.screen')) actions.view(s, action === 'control');
  });
  // Shift-click shouldn't also select the page's text.
  el.addEventListener('mousedown', (e) => e.shiftKey && e.preventDefault());
  el.addEventListener('contextmenu', (e) => {
    const s = store.get(id);
    if (!s) return;
    e.preventDefault();
    actions.menu(s, { x: e.clientX, y: e.clientY });
  });
  return { el, img: el.querySelector('img')!, thumbUrl: null };
}

function renderCard(id: string): void {
  const s = store.get(id);
  let card = cards.get(id);
  if (!s || !visible(s)) {
    if (card) removeCard(id);
    updateCounts();
    return;
  }
  const isNew = !card;
  if (!card) {
    card = createCard(id);
    cards.set(id, card);
  }
  const { el } = card;
  el.classList.toggle('offline', !s.online);
  el.classList.toggle('locked', s.online && s.status.locked);
  el.classList.toggle('controlled', s.status.controlled);
  el.classList.toggle('selected', targets.isSelected(id));
  el.querySelector('.name')!.textContent = store.displayName(s);
  el.querySelector('.meta')!.textContent = [s.name ? store.computerName(s) : null, s.username, s.address].filter(Boolean).join(' · ');
  el.querySelector('.os')!.textContent = OS_LABEL[s.platform] ?? s.platform;
  el.querySelector('.placeholder')!.textContent = s.online ? 'Waiting for screen…' : `Offline · last seen ${timeAgo(s.lastSeen)}`;
  el.querySelector('.badges')!.replaceChildren(...badges(s));

  const locked = s.policy.lock !== null;
  const lockChip = el.querySelector('[data-action="lock"]')!;
  lockChip.querySelector('span')!.textContent = locked ? 'Unlock' : 'Lock';
  lockChip.querySelector('use')!.setAttribute('href', locked ? '#i-unlock' : '#i-lock');

  if (isNew) place(card, id);
  updateCounts();
}

function pill(text: string, kind = ''): HTMLElement {
  return Object.assign(document.createElement('span'), { className: `pill ${kind}`.trim(), textContent: text });
}

/** Status pills on the thumbnail: what the teacher should notice at a glance. */
function badges(s: Student): HTMLElement[] {
  if (!s.online) return [];
  const result: HTMLElement[] = [];
  if (s.status.hand !== null) result.push(pill('✋ Needs help', 'hand'));
  if (s.status.controlled) result.push(pill('Being controlled', 'chat'));
  else if (s.status.locked) result.push(pill('Locked'));
  if (s.unread) result.push(pill(`${s.unread} new message${s.unread === 1 ? '' : 's'}`, 'chat'));
  if (s.answer !== null) result.push(pill(s.answer, 'answer'));
  return result;
}

function renderAll(): void {
  for (const id of [...cards.keys()]) if (!store.get(id)) removeCard(id);
  for (const s of store.all()) renderCard(s.id);
  // Re-append in sorted order; moving existing nodes keeps their thumbnails.
  for (const s of store.all()) {
    const card = cards.get(s.id);
    if (card) grid.append(card.el);
  }
  targets.refresh();
  updateCounts();
}

/** Inserts a new card in name order. */
function place(card: Card, id: string): void {
  const order = visibleIds();
  const next = order.slice(order.indexOf(id) + 1).find((other) => cards.get(other)?.el.isConnected);
  if (next) grid.insertBefore(card.el, cards.get(next)!.el);
  else grid.append(card.el);
}

function removeCard(id: string): void {
  const card = cards.get(id);
  if (!card) return;
  if (card.thumbUrl) URL.revokeObjectURL(card.thumbUrl);
  card.el.remove();
  cards.delete(id);
}

export function showThumb(id: string, jpeg: Uint8Array): void {
  const card = cards.get(id);
  if (!card) return;
  const previous = card.thumbUrl;
  card.thumbUrl = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
  card.img.src = card.thumbUrl;
  if (previous) card.img.decode().finally(() => URL.revokeObjectURL(previous));
}

function updateCounts(): void {
  const everyone = store.all();
  const online = everyone.filter((s) => s.online).length;
  const offline = everyone.length - online;
  $('#count').textContent = offline ? `${online} online · ${offline} offline` : `${online} online`;
  $('#empty').hidden = cards.size > 0;
  const group = groups.current();
  $('#empty').querySelector('h1')!.textContent = group
    ? `Nobody in ${group.name} to show`
    : everyone.length
      ? 'Nobody is online yet'
      : 'Waiting for students';
  $('#select-all').title = `Select ${plural(visibleIds().length, 'visible student')}`;
}
