// The menu-bar / taskbar icon: always tells the student whether the teacher is
// connected, watching or controlling.

import { app, Menu, nativeImage, shell, systemPreferences, Tray } from 'electron';
import { controlled, viewing } from './session';
import { canOfferSetup, openSetup } from './setup';
import { state } from './state';

const canQuit = !app.isPackaged || process.env.CM_ALLOW_QUIT === '1';
let tray: Tray | null = null;

/** A ring with a centre dot, drawn at 32px for a 16pt (Retina) tray icon. */
function trayIcon(color: [number, number, number] | null): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = color ?? [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const ring = Math.min(1, Math.max(0, Math.min(d - 9.5, 13.5 - d) + 0.5));
      const dot = Math.min(1, Math.max(0, 5 - d + 0.5));
      const alpha = Math.round(255 * Math.max(ring, dot));
      const i = (y * size + x) * 4;
      buf[i] = Math.round((b * alpha) / 255); // BGRA, premultiplied
      buf[i + 1] = Math.round((g * alpha) / 255);
      buf[i + 2] = Math.round((r * alpha) / 255);
      buf[i + 3] = alpha;
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  if (!color) image.setTemplateImage(true);
  return image;
}

const GREEN: [number, number, number] = [31, 157, 85];
const GREY: [number, number, number] = [138, 144, 155];

export function createTray(): void {
  tray = new Tray(trayIcon(process.platform === 'darwin' ? null : GREY));
  updateTray();
}

export function popUpTray(): void {
  tray?.popUpContextMenu();
}

function statusLine(): string {
  const { config, problem, teacher } = state;
  if (!config) return 'Not set up yet: join a class to start';
  if (problem === 'key') return `The teacher of ${config.room} didn't accept the class key`;
  if (problem === 'version') return `The teacher of ${config.room} runs a different ClassMonitor version`;
  if (!teacher) return `Looking for the teacher of ${config.room}…`;
  return `Connected to ${teacher.name} (${teacher.room})`;
}

export function updateTray(): void {
  if (!tray) return;
  const connected = state.teacher !== null;
  if (process.platform !== 'darwin') tray.setImage(trayIcon(connected ? GREEN : GREY));

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'ClassMonitor Student', enabled: false },
    { label: statusLine(), enabled: false },
  ];
  if (connected) items.push({ label: 'Your teacher can see this screen', enabled: false });
  if (viewing()) items.push({ label: 'Your teacher is watching this screen now', enabled: false });
  if (controlled()) items.push({ label: 'Your teacher is controlling this computer', enabled: false });
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    items.push({ type: 'separator' }, {
      label: 'Allow Screen Recording…',
      click: () => void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    });
  }
  if (canOfferSetup()) {
    const label = !state.config ? 'Join a class…' : state.problem === 'key' ? 'Fix the class key…' : 'Change class…';
    items.push({ type: 'separator' }, { label, click: openSetup });
  } else if (state.managed && state.problem === 'key') {
    items.push({ label: 'Ask IT to update the class key on this computer', enabled: false });
  }
  if (state.problem === 'version') items.push({ label: 'Ask your teacher or IT to update ClassMonitor', enabled: false });
  if (canQuit) items.push({ type: 'separator' }, { label: 'Quit (development only)', click: () => app.exit(0) });

  tray.setToolTip(`ClassMonitor: ${statusLine()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
