// The grid of student cards: thumbnails, status, selection, per-card actions,
// and the order the teacher drags the cards into.

import { blocksEverySite } from '../../shared/web-rules';
import { rearrange } from '../order';
import { askConfirm } from './dialogs';
import { $, api, errorText, OS_LABEL, plural, prefs, timeAgo, toast } from './dom';
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
  wake(s: Student): void;
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
const sortButton = $<HTMLButtonElement>('#sort-name');
let actions: CardActions;

const remembered = prefs.get;
const remember = prefs.set;

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

  initArranging();
  sortButton.addEventListener('click', async () => {
    const ok = await askConfirm('Sort the cards by name?', 'The order you dragged the computers into is replaced by name order.', 'Sort by name');
    if (ok) void saveOrder([]);
  });

  // Offline cards say how long ago each computer was seen; keep that fresh.
  setInterval(() => {
    for (const s of store.all()) if (!s.online) renderCard(s.id);
  }, 60_000);
}

const visible = (s: Student) => groups.inView(s.id) && (s.online || showOfflineInput.checked);

/** Ids of the cards on screen, in display order (for Shift-click ranges and Select all). */
export function visibleIds(): string[] {
  return store.inCardOrder().filter(visible).map((s) => s.id);
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
    else if (action === 'wake') actions.wake(s);
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
  if (!s) {
    removeCard(id);
    updateCounts();
    return;
  }
  if (!visible(s)) {
    // Hidden by the group view or "Show offline": keep the card (and its
    // thumbnail) for when it comes back into view.
    card?.el.remove();
    updateCounts();
    return;
  }
  if (!card) {
    card = createCard(id);
    cards.set(id, card);
  }
  const isNew = !card.el.isConnected;
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
  const lockChip = el.querySelector<HTMLElement>('[data-action="lock"]')!;
  lockChip.querySelector('.label')!.textContent = locked ? 'Unlock' : 'Lock';
  lockChip.title = locked ? 'Unlock' : 'Lock';
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
  if (s.displays.length > 1) result.push(pill(`${s.displays.length} screens`, 'chat'));
  if (s.policy.apps) result.push(pill('Apps blocked'));
  // Chrome/Edge open but the extension never reported in: the rules can't apply there.
  if (s.policy.web) {
    const rules = blocksEverySite(s.policy.web) ? 'Websites blocked' : 'Web rules on';
    result.push(s.web?.extension || !s.web?.browserOpen ? pill(rules) : pill('Web filter missing', 'hand'));
  }
  const site = s.web?.url ? hostname(s.web.url) : null;
  if (site) result.push(pill(site, 'answer'));
  if (s.answer !== null) result.push(pill(s.answer, 'answer'));
  return result;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function renderAll(): void {
  for (const id of [...cards.keys()]) if (!store.get(id)) removeCard(id);
  for (const s of store.all()) renderCard(s.id);
  // Re-append in card order; moving existing nodes keeps their thumbnails.
  for (const s of store.inCardOrder()) {
    const card = cards.get(s.id);
    if (card?.el.isConnected) grid.append(card.el);
  }
  targets.refresh();
  updateCounts();
}

/** Inserts a new card at its place in the card order. */
function place(card: Card, id: string): void {
  const order = visibleIds();
  const next = order.slice(order.indexOf(id) + 1).find((other) => cards.get(other)?.el.isConnected);
  if (next) grid.insertBefore(card.el, cards.get(next)!.el);
  else grid.append(card.el);
}

// ---------------------------------------------------------------- arranging
// Drag a card onto another to move it there (e.g. to match the room's seating).
// The other cards make room while dragging; letting go saves the order, and
// Esc or letting go outside the grid puts the card back.

const DRAG_TYPE = 'application/x-classmonitor-card';
/** The card being dragged, while a drag is on. */
let dragged: HTMLElement | null = null;
let dropped = false;

function initArranging(): void {
  // Listen on the whole grid area so dropping below the last row works too.
  const area = grid.parentElement!;
  grid.addEventListener('dragstart', (e) => {
    const el = e.target as HTMLElement;
    if (!el.classList?.contains('card') || !e.dataTransfer) return;
    dragged = el;
    dropped = false;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, el.dataset.id!);
    // Fade the card once the browser has taken its picture for the drag.
    requestAnimationFrame(() => dragged === el && el.classList.add('dragging'));
  });
  area.addEventListener('dragover', (e) => {
    // Only our own cards: not files or text dragged in from elsewhere.
    if (!dragged || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    moveDragged(e.target as HTMLElement, e.clientX, e.clientY);
  });
  area.addEventListener('drop', (e) => {
    if (!dragged || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    dropped = true;
    const before = store.inCardOrder().map((s) => s.id);
    const shown = [...grid.children].map((el) => (el as HTMLElement).dataset.id!);
    const after = rearrange(before, shown);
    if (after.some((id, i) => id !== before[i])) void saveOrder(after);
  });
  grid.addEventListener('dragend', () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    if (!dropped) renderAll();
  });
}

/** Moves the dragged card next to the one under the pointer: before it on its left half, after it on its right. */
function moveDragged(target: HTMLElement, x: number, y: number): void {
  if (!dragged) return;
  const over = target.closest<HTMLElement>('.card');
  if (over) {
    if (over === dragged) return;
    const { left, width } = over.getBoundingClientRect();
    if (x < left + width / 2) {
      if (over.previousElementSibling !== dragged) over.before(dragged);
    } else if (over.nextElementSibling !== dragged) over.after(dragged);
    return;
  }
  // Past the last card (beside it or below the grid): move to the end.
  const last = grid.lastElementChild as HTMLElement | null;
  if (!last || last === dragged) return;
  const box = last.getBoundingClientRect();
  if (y > box.bottom || (y > box.top && x > box.right)) grid.append(dragged);
}

async function saveOrder(ids: string[]): Promise<void> {
  store.setOrder(ids); // Show it at once; roster.json catches up.
  try {
    await api.saveOrder(ids);
  } catch (err) {
    toast(errorText(err));
  }
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
  $('#empty').hidden = [...cards.values()].some((c) => c.el.isConnected);
  const group = groups.current();
  $('#empty').querySelector('h1')!.textContent = group
    ? `Nobody in ${group.name} to show`
    : everyone.length
      ? 'Nobody is online yet'
      : 'Waiting for students';
  $('#select-all').title = `Select ${plural(visibleIds().length, 'visible student')}`;
  sortButton.hidden = !store.arranged();
}
