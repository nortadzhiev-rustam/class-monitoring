// Toolbar actions that act on the students' computers themselves: open a
// website or app, block apps, website rules, and power (log off, restart,
// shut down, wake).

import type { PowerAction } from '../../shared/protocol';
import { MAX_DOMAINS, normaliseDomain } from '../../shared/web-rules';
import { askConfirm, askText } from './dialogs';
import { $, api, errorText, plural, prefs, toast } from './dom';
import { showMenu } from './menu';
import * as store from './store';
import type { Resolved } from './targets';

const nobody = () => toast('Nobody you picked is online.');

/** Runs an action and reports how many computers it reached. */
async function report(sent: Promise<number>, done: (n: number) => string): Promise<void> {
  try {
    const n = await sent;
    if (n) toast(done(n), 'info');
    else nobody();
  } catch (err) {
    toast(errorText(err));
  }
}

const forWhom = (to: Resolved) => (to.target.everyone ? 'everyone' : to.label);

// ---------------------------------------------------------------- open

export function openMenu(anchor: HTMLElement, to: Resolved): void {
  showMenu(anchor, [
    { label: 'Website…', action: () => void openWebsite(to) },
    { label: 'App…', action: () => void openApp(to) },
  ]);
}

async function openWebsite(to: Resolved): Promise<void> {
  const raw = await askText(`Open a website for ${forWhom(to)}`, 'Web address', prefs.get('lastUrl') ?? 'https://', 'Open');
  if (!raw) return;
  const url = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  prefs.set('lastUrl', url);
  await report(api.openUrl(to.target, url), (n) => `Opened ${url} on ${plural(n, 'computer')}.`);
}

async function openApp(to: Resolved): Promise<void> {
  const name = await askText(`Open an app for ${forWhom(to)}`, 'App name, e.g. Calculator, Word or notepad', prefs.get('lastApp') ?? '', 'Open');
  if (!name) return;
  prefs.set('lastApp', name);
  await report(api.openApp(to.target, name), (n) => `Opening ${name} on ${plural(n, 'computer')}.`);
}

// ---------------------------------------------------------------- block apps

const appsDialog = $<HTMLDialogElement>('#apps-dialog');
const appsList = $<HTMLTextAreaElement>('#apps-list');
let appsTarget: Resolved | null = null;

const lines = (text: string) => [...new Set(text.split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean))];

export function blockApps(to: Resolved): void {
  appsTarget = to;
  $('#apps-title').textContent = `Block apps for ${forWhom(to)}`;
  appsList.value = prefs.get('blockedApps') ?? '';
  appsDialog.returnValue = '';
  appsDialog.showModal();
  appsList.focus();
}

for (const preset of $('#apps-presets').querySelectorAll<HTMLElement>('[data-apps]')) {
  preset.addEventListener('click', () => {
    appsList.value = lines(`${appsList.value}\n${preset.dataset.apps!.split('|').join('\n')}`).join('\n');
  });
}

appsDialog.addEventListener('close', () => {
  const to = appsTarget;
  appsTarget = null;
  if (!to) return;
  if (appsDialog.returnValue === 'off') {
    api.setApps(to.target, null);
    toast(`Apps unblocked for ${forWhom(to)}.`, 'info');
  } else if (appsDialog.returnValue === 'on') {
    const apps = lines(appsList.value);
    if (!apps.length) {
      toast('Add at least one app to block.');
      return;
    }
    prefs.set('blockedApps', apps.join('\n'));
    api.setApps(to.target, apps);
    toast(`Blocking ${plural(apps.length, 'app')} for ${forWhom(to)}.`, 'info');
  }
});

// ---------------------------------------------------------------- websites

const webDialog = $<HTMLDialogElement>('#web-dialog');
const webList = $<HTMLTextAreaElement>('#web-list');
const closeOthers = $<HTMLInputElement>('#web-close-others');
let webTarget: Resolved | null = null;

const webPresets = $('#web-presets');
const webApply = $<HTMLButtonElement>('#web-on');

const webMode = () => (document.querySelector<HTMLInputElement>('input[name="web-mode"]:checked')?.value === 'allow' ? 'allow' : 'block');

/** The teacher's lines as the sites the filter will use, plus the lines it can't read. */
function parseSites(text: string): { domains: string[]; bad: string[] } {
  const domains = new Set<string>();
  const bad: string[] = [];
  for (const line of lines(text)) {
    const domain = normaliseDomain(line);
    if (domain) domains.add(domain);
    else bad.push(line);
  }
  return { domains: [...domains], bad };
}

/** Keeps the label, examples, presets, summary and Apply button in step with the rule and list. */
function updateWebForm(): void {
  const mode = webMode();
  const { domains, bad } = parseSites(webList.value);
  $('#web-list-label').textContent = mode === 'block' ? 'Sites to block, one per line' : 'Sites students can open, one per line';
  webList.placeholder = mode === 'block' ? 'youtube.com\ntiktok.com' : 'classroom.google.com\nwikipedia.org';
  // The presets are distractions to block; adding them to an allow-list would do the opposite.
  webPresets.hidden = mode === 'allow';
  const n = plural(domains.length, 'site');
  $('#web-count').textContent =
    mode === 'block'
      ? domains.length ? `${n} blocked, with their subdomains.` : 'Add the sites to block.'
      : domains.length ? `Only ${n} and their subdomains will open.` : 'No site will open in Chrome or Edge.';
  const shown = bad.slice(0, 3).map((line) => `"${line}"`).join(', ');
  $('#web-bad').textContent = bad.length
    ? `Not a web address, skipped: ${shown}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}.`
    : domains.length > MAX_DOMAINS ? `Only the first ${MAX_DOMAINS} sites are used.` : '';
  webApply.disabled = mode === 'block' && !domains.length;
}

export function webRules(to: Resolved): void {
  webTarget = to;
  $('#web-title').textContent = `Websites for ${forWhom(to)}`;
  webList.value = prefs.get('webSites') ?? '';
  const mode = prefs.get('webMode') === 'allow' ? 'allow' : 'block';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="web-mode"]')) radio.checked = radio.value === mode;
  closeOthers.checked = prefs.get('webCloseOthers') !== 'false';
  updateWebForm();
  webDialog.returnValue = '';
  webDialog.showModal();
  webList.focus();
}

webList.addEventListener('input', updateWebForm);
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="web-mode"]')) radio.addEventListener('change', updateWebForm);

for (const preset of webPresets.querySelectorAll<HTMLElement>('[data-sites]')) {
  preset.addEventListener('click', () => {
    webList.value = lines(`${webList.value}\n${preset.dataset.sites!.split('|').join('\n')}`).join('\n');
    webList.scrollTop = webList.scrollHeight;
    updateWebForm();
  });
}

webDialog.addEventListener('close', () => {
  const to = webTarget;
  webTarget = null;
  if (!to) return;
  if (webDialog.returnValue === 'off') {
    api.setWeb(to.target, null);
    toast(`All websites allowed again for ${forWhom(to)}.`, 'info');
    return;
  }
  if (webDialog.returnValue !== 'on') return;
  const domains = parseSites(webList.value).domains.slice(0, MAX_DOMAINS);
  const mode = webMode();
  if (mode === 'block' && !domains.length) {
    toast('Add at least one site to block.');
    return;
  }
  prefs.set('webSites', lines(webList.value).join('\n'));
  prefs.set('webMode', mode);
  prefs.set('webCloseOthers', String(closeOthers.checked));
  api.setWeb(to.target, { mode, domains, closeOtherBrowsers: closeOthers.checked });
  toast(
    mode === 'block' ? `Blocking ${plural(domains.length, 'site')} for ${forWhom(to)}.` : `Only ${plural(domains.length, 'site')} allowed for ${forWhom(to)}.`,
    'info',
  );
});

// ---------------------------------------------------------------- power

const VERB: Record<PowerAction, string> = { logoff: 'Log off', restart: 'Restart', shutdown: 'Shut down' };

export function powerMenu(anchor: HTMLElement, to: Resolved): void {
  const offline = to.target.ids.filter((id) => store.get(id) && !store.get(id)!.online);
  showMenu(anchor, [
    { label: 'Log off…', action: () => void power(to, 'logoff') },
    { label: 'Restart…', action: () => void power(to, 'restart') },
    { label: 'Shut down…', danger: true, action: () => void power(to, 'shutdown') },
    'separator',
    { label: offline.length ? `Wake up ${plural(offline.length, 'offline computer')}` : 'Wake up offline computers', disabled: !offline.length, action: () => void wakeUp(offline) },
  ]);
}

async function power(to: Resolved, action: PowerAction): Promise<void> {
  if (!to.online) {
    nobody();
    return;
  }
  const verb = VERB[action];
  const ok = await askConfirm(
    `${verb} ${to.target.everyone ? 'every computer' : to.label}?`,
    `${plural(to.online, 'student')} will see a 15-second warning to save their work. After that, anything unsaved is lost.`,
    verb,
  );
  if (ok) await report(api.power(to.target, action), (n) => `${verb} starting on ${plural(n, 'computer')}.`);
}

export async function wakeUp(ids: string[]): Promise<void> {
  const offline = ids.filter((id) => !store.get(id)?.online);
  if (!offline.length) {
    toast('Those computers are already on.');
    return;
  }
  try {
    const n = await api.wake(offline);
    if (n) toast(`Sent a wake-up signal to ${plural(n, 'computer')}. Only computers with Wake-on-LAN turned on will start.`, 'info');
    else toast("ClassMonitor doesn't know the network address of those computers yet.");
  } catch (err) {
    toast(errorText(err));
  }
}
