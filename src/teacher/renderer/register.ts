// Attendance register: students sign in with their name; the teacher sees who
// is here and who is missing, and can export it as CSV.

import { $, api, errorText, plural, toast } from './dom';
import * as panel from './panel';
import * as store from './store';
import type { Resolved } from './targets';

interface Register {
  registerId: string;
  to: Resolved;
  startedAt: number;
  signed: Map<string, { name: string; at: number }>;
  ended: boolean;
}

let register: Register | null = null;
let newRegister: () => void = () => {};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function init(options: { newRegister: () => void }): void {
  newRegister = options.newRegister;
  $('#register-new').addEventListener('click', () => newRegister());
  $('#register-end').addEventListener('click', () => {
    if (!register) return;
    if (register.ended) newRegister();
    else end();
  });
  $('#register-export').addEventListener('click', () => void exportCsv());
  store.onChange(() => register && render());
  render();
}

export async function start(to: Resolved): Promise<void> {
  try {
    const registerId = await api.registerStart(to.target);
    register = { registerId, to, startedAt: Date.now(), signed: new Map(), ended: false };
    panel.open('register');
    render();
  } catch (err) {
    toast(errorText(err));
  }
}

export function signIn(id: string, registerId: string, name: string): void {
  store.setName(id, name);
  if (!register || register.ended || register.registerId !== registerId) return;
  register.signed.set(id, { name, at: Date.now() });
  render();
}

function end(): void {
  if (!register) return;
  api.registerEnd();
  register.ended = true;
  render();
}

/** Everyone the register was for, including students who never came online (absent). */
function expected(r: Register): string[] {
  const ids = r.to.target.everyone ? store.all().map((s) => s.id) : r.to.target.ids.filter((id) => store.get(id));
  return [...new Set([...ids, ...r.signed.keys()])];
}

async function exportCsv(): Promise<void> {
  if (!register) return;
  const r = register;
  const date = new Date(r.startedAt);
  const rows = [['Name', 'Computer', 'User', 'Status', 'Signed in']];
  for (const id of expected(r)) {
    const s = store.get(id);
    const signed = r.signed.get(id);
    rows.push([signed?.name ?? s?.name ?? '', s ? store.computerName(s) : '', s?.username ?? '', signed ? 'Present' : 'Not signed in', signed ? new Date(signed.at).toLocaleString() : '']);
  }
  const day = date.toISOString().slice(0, 10);
  try {
    const file = await api.saveCsv(`Register ${day} ${time(r.startedAt).replace(':', '.')}.csv`, rows);
    if (file) toast(`Register saved to ${file}`, 'info');
  } catch (err) {
    toast(errorText(err));
  }
}

function render(): void {
  $('#register-results').hidden = !register;
  $('#register-empty').hidden = !!register;
  if (!register) return;
  const r = register;
  const ids = expected(r);
  $('#register-state').textContent = r.ended ? `Register ended · started ${time(r.startedAt)}` : `Live · ${r.to.label}`;
  $('#register-count').textContent = `${r.signed.size} of ${plural(ids.length, 'student')} signed in`;
  $('#register-end').textContent = r.ended ? 'New register' : 'End register';

  const present = ids.filter((id) => r.signed.has(id)).sort((a, b) => r.signed.get(a)!.name.localeCompare(r.signed.get(b)!.name));
  const missing = ids.filter((id) => !r.signed.has(id));
  $('#register-list').replaceChildren(
    ...present.map((id) => {
      const s = store.get(id);
      const signed = r.signed.get(id)!;
      return row(signed.name, `${s ? store.computerName(s) : ''} · ${time(signed.at)}`, false);
    }),
    ...missing.map((id) => {
      const s = store.get(id)!;
      return row(store.computerName(s), s.online ? 'Not signed in yet' : 'Offline', true);
    }),
  );
}

function row(name: string, detail: string, missing: boolean): HTMLElement {
  const li = Object.assign(document.createElement('li'), { className: missing ? 'missing' : '' });
  li.append(
    Object.assign(document.createElement('span'), { className: 'who-name', textContent: name }),
    Object.assign(document.createElement('span'), { className: 'detail', textContent: detail }),
  );
  return li;
}
