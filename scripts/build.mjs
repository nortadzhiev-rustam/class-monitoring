// Bundles the Electron main/preload scripts (Node, CommonJS) and the
// renderer scripts (browser, IIFE) into dist/, then copies static assets.
import { build } from 'esbuild';
import { cp, readdir, rm } from 'node:fs/promises';

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'warning' };

await rm('dist', { recursive: true, force: true });

await build({
  ...common,
  platform: 'node',
  format: 'cjs',
  // ws optionally requires these native add-ons; it works without them.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  entryPoints: {
    'teacher/main': 'src/teacher/main.ts',
    'teacher/preload': 'src/teacher/preload.ts',
    'student/main': 'src/student/main.ts',
    'student/preload': 'src/student/preload.ts',
  },
  outdir: 'dist',
});

await build({
  ...common,
  platform: 'browser',
  format: 'iife',
  entryPoints: {
    'teacher/app': 'src/teacher/renderer/app.ts',
    'student/agent': 'src/student/renderer/agent.ts',
    'student/overlay': 'src/student/renderer/overlay.ts',
    'student/setup': 'src/student/renderer/setup.ts',
  },
  outdir: 'dist',
});

await cp('static', 'dist', { recursive: true });

// `--tests`: bundle tests/unit/*.test.ts for `node --test`.
if (process.argv.includes('--tests')) {
  const tests = (await readdir('tests/unit')).filter((f) => f.endsWith('.test.ts'));
  await rm('dist-tests', { recursive: true, force: true });
  await build({
    ...common,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    entryPoints: tests.map((f) => `tests/unit/${f}`),
    outdir: 'dist-tests',
    outExtension: { '.js': '.cjs' },
  });
}
console.log('Built dist/');
