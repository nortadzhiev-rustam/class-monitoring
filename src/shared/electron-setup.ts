import { app, desktopCapturer, screen, session, type DesktopCapturerSource } from 'electron';
import path from 'node:path';

/** Must run before `app.whenReady()`. */
export function configureApp(role: 'Teacher' | 'Student'): void {
  const name = `ClassMonitor ${role}`;
  app.setName(name);
  app.setPath('userData', process.env.CM_USER_DATA ?? path.join(app.getPath('appData'), name));
  // WebRTC on a LAN: expose real host IPs instead of mDNS ".local" names, which
  // school networks often can't resolve because multicast is filtered.
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}

/** Files shipped next to the app: `resources/` when packaged, the repo root in development. */
export function resourcePath(...parts: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, '..', '..', ...parts);
}

export async function primaryScreenSource(thumbnailWidth = 0): Promise<DesktopCapturerSource | undefined> {
  const display = screen.getPrimaryDisplay();
  const thumbnailSize = thumbnailWidth
    ? { width: thumbnailWidth, height: Math.round((thumbnailWidth * display.size.height) / display.size.width) }
    : { width: 0, height: 0 };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  return sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
}

/**
 * Answers `getDisplayMedia()` from our own pages with the primary screen, without
 * the system picker. Only pages we load ourselves can call it.
 */
export function shareScreenWithoutPicker(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const source = await primaryScreenSource();
      callback(source ? { video: source } : {});
    } catch (err) {
      console.error('[capture] no screen source:', err);
      callback({});
    }
  });
}
