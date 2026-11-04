// ClassMonitor Web Filter (Chrome/Edge, Manifest V3).
//
// Connects to the ClassMonitor Student app through native messaging, applies
// the teacher's website rules with declarativeNetRequest, and reports the
// student's current tab. If the student app isn't running the rules are
// lifted, the same way a student is unlocked when the teacher disconnects.

import { NATIVE_HOST, toDnrRules, type DnrRule, type WebRules } from '../shared/web-rules';

// Only the parts of the chrome.* API this worker uses.
interface Port {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: { type?: string; rules?: WebRules | null }) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
interface Tab {
  url?: string;
  title?: string;
}
declare const chrome: {
  runtime: {
    connectNative(host: string): Port;
    getManifest(): { version: string };
    onStartup: { addListener(listener: () => void): void };
    onInstalled: { addListener(listener: () => void): void };
  };
  declarativeNetRequest: {
    getDynamicRules(): Promise<DnrRule[]>;
    updateDynamicRules(update: { removeRuleIds: number[]; addRules: DnrRule[] }): Promise<void>;
  };
  tabs: {
    query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<Tab[]>;
    onActivated: { addListener(listener: () => void): void };
    onUpdated: { addListener(listener: (tabId: number, change: { url?: string; status?: string }) => void): void };
  };
  windows: { onFocusChanged: { addListener(listener: () => void): void } };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
};

let port: Port | null = null;

async function applyRules(rules: WebRules | null): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: toDnrRules(rules) });
}

async function reportTab(): Promise<void> {
  if (!port) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  port.postMessage({ type: 'tab', url: tab?.url ?? null, title: tab?.title ?? null });
}

function connect(): void {
  if (port) return;
  let connected: Port;
  try {
    connected = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return; // Not registered on this computer; the alarm tries again later.
  }
  port = connected;
  connected.onMessage.addListener((message) => {
    if (message.type === 'rules') void applyRules(message.rules ?? null);
  });
  connected.onDisconnect.addListener(() => {
    port = null;
    void applyRules(null);
  });
  connected.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version });
  void reportTab();
}

chrome.tabs.onActivated.addListener(() => void reportTab());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') void reportTab();
});
chrome.windows.onFocusChanged.addListener(() => void reportTab());

// The service worker can be stopped while disconnected; the alarm brings it
// back to retry. An open native port keeps it alive while connected.
chrome.alarms.create('connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === 'connect' && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
