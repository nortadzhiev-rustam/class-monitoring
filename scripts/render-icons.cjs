// Renders build/icon-<app>.svg to the 1024×1024 PNGs electron-builder turns into
// .icns and .ico files. Uses Electron's own renderer, so no image tools are needed.
// Run: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const build = path.join(__dirname, '..', 'build');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.dock?.hide();

app.whenReady().then(async () => {
  for (const name of ['teacher', 'student']) {
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
    await win.loadFile(path.join(build, `icon-${name}.svg`));
    // Offscreen windows hand over each frame as it's painted; take the next full one.
    const image = await new Promise((resolve) => {
      win.webContents.on('paint', (_e, _dirty, frame) => {
        if (!frame.isEmpty()) resolve(frame);
      });
      win.webContents.invalidate();
    });
    const { width, height } = image.getSize();
    if (width !== SIZE || height !== SIZE) throw new Error(`icon-${name}: rendered ${width}×${height}, expected ${SIZE}×${SIZE}`);
    fs.writeFileSync(path.join(build, `icon-${name}.png`), image.toPNG());
    console.log(`build/icon-${name}.png`);
    // Closing the window here would take down the renderer the next icon reuses.
  }
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
