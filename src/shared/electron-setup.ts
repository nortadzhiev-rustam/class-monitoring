import { app, desktopCapturer, screen, session, type DesktopCapturerSource } from 'electron';
import path from 'node:path';

/** The apps' names as people see them (Tajik: "lookout", teacher and pupil). */
export const APP_NAMES = { Teacher: 'Дидбон Омӯзгор', Student: 'Дидбон Хонанда' } as const;

/** Must run before `app.whenReady()`. */
export function configureApp(role: 'Teacher' | 'Student'): void {
  app.setName(APP_NAMES[role]);
  // The settings folder keeps the original name, so computers keep their class, key and roster.
  app.setPath('userData', process.env.CM_USER_DATA ?? path.join(app.getPath('appData'), `ClassMonitor ${role}`));
}

/** Files shipped next to the app: `resources/` when packaged, the repo root in development. */
export function resourcePath(...parts: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, '..', '..', ...parts);
}

/** The capture source for one display (`displayId` as in `screen.getAllDisplays()`), or the primary one. */
async function screenSource(displayId?: string, thumbnailWidth = 0): Promise<DesktopCapturerSource | undefined> {
  const display = screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
  const thumbnailSize = thumbnailWidth
    ? { width: thumbnailWidth, height: Math.round((thumbnailWidth * display.size.height) / display.size.width) }
    : { width: 0, height: 0 };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  return sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
}

export const primaryScreenSource = (thumbnailWidth = 0) => screenSource(undefined, thumbnailWidth);

/**
 * Answers `getDisplayMedia()` from our own pages without the system picker: with
 * the display `chosenDisplay()` names, else the primary screen. Only pages we
 * load ourselves can call it.
 */
export function shareScreenWithoutPicker(chosenDisplay: () => string | undefined = () => undefined): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const source = await screenSource(chosenDisplay());
      callback(source ? { video: source } : {});
    } catch (err) {
      console.error('[capture] no screen source:', err);
      callback({});
    }
  });
}
