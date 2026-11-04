import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedBy, displayName, programNames } from '../../src/shared/app-match';

test('apps match by executable or .app bundle, ignoring case and extension', () => {
  assert.equal(blockedBy('C:\\Program Files\\Steam\\steam.exe', ['Steam']), 'Steam');
  assert.equal(blockedBy('/Applications/Steam.app/Contents/MacOS/steam_osx', ['steam']), 'steam');
  assert.equal(blockedBy('/Applications/Discord.app/Contents/MacOS/Discord', ['discord']), 'discord');
  assert.equal(blockedBy('/usr/bin/sleep', ['steam', 'discord']), null);
});

test('* is a wildcard, everything else is literal', () => {
  assert.equal(blockedBy('steamwebhelper.exe', ['steam*']), 'steam*');
  assert.equal(blockedBy('steamwebhelper.exe', ['steam']), null);
  assert.equal(blockedBy('a+b.exe', ['a+b']), 'a+b');
  assert.equal(blockedBy('aab.exe', ['a+b']), null);
});

test('the OS shell and ClassMonitor itself are never blocked', () => {
  assert.equal(blockedBy('C:\\Windows\\explorer.exe', ['*']), null);
  assert.equal(blockedBy('/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', ['finder']), null);
  assert.equal(blockedBy('/Applications/ClassMonitor Student.app/Contents/MacOS/ClassMonitor Student', ['*']), null);
  assert.equal(blockedBy('/Applications/Minecraft.app/Contents/MacOS/launcher', ['*']), '*');
});

test('names shown to students are readable', () => {
  assert.equal(displayName('/Applications/Steam.app/Contents/MacOS/steam_osx'), 'Steam');
  assert.equal(displayName('C:\\Games\\Minecraft.exe'), 'Minecraft');
  assert.deepEqual(programNames('/Applications/Steam.app/Contents/MacOS/steam_osx'), ['steam_osx', 'steam']);
});
