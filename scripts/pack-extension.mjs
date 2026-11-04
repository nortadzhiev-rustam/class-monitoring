// Packages the web filter extension for the Chrome Web Store and Edge Add-ons:
// dist/extension without source maps, and without the development "key"
// (the stores assign their own), zipped into release/.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = 'dist/extension';
const staging = 'release/extension';
await rm(staging, { recursive: true, force: true });
await mkdir('release', { recursive: true });
await cp(source, staging, { recursive: true, filter: (file) => !file.endsWith('.map') });

const manifestPath = path.join(staging, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
delete manifest.key;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const zip = path.resolve(`release/classmonitor-web-filter-${manifest.version}.zip`);
await rm(zip, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}'`]);
} else {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
}
console.log(`Packed ${path.relative(process.cwd(), zip)} (upload this to the Chrome Web Store and Edge Add-ons)`);
