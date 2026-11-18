import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** The productName line of an electron-builder config; double-quoted YAML escapes (\uXXXX) read like JSON's. */
function productName(file: string): string {
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('productName:'));
  assert.ok(line, `${file} has a productName`);
  const value = line.slice('productName:'.length).trim();
  return value.startsWith('"') ? JSON.parse(value) : value;
}

test('app names are stored decomposed (NFD), the way macOS names the app files', () => {
  // A composed letter such as ӯ (one code point) in Info.plist, against the
  // decomposed у + macron that electron-builder uses for the file names, makes
  // Electron miss its helper apps and crash at launch on Apple silicon.
  for (const file of ['electron-builder.teacher.yml', 'electron-builder.student.yml']) {
    const name = productName(file);
    assert.equal(name, name.normalize('NFD'), `${file}: write ${JSON.stringify(name)} decomposed, e.g. ӯ as \\u0443\\u0304`);
  }
  assert.equal(productName('electron-builder.teacher.yml').normalize('NFC'), 'Дидбон Омӯзгор');
  assert.equal(productName('electron-builder.student.yml').normalize('NFC'), 'Дидбон Хонанда');
});
