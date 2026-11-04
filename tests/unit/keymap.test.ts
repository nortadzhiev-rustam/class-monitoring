import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeKey } from '../../src/shared/keymap';

test('letters map to macOS and Windows key codes', () => {
  assert.deepEqual(nativeKey('KeyA', 'darwin', 'darwin'), { mac: 0x00, win: 0x41 });
  assert.equal(nativeKey('KeyZ', 'win32', 'win32')?.win, 0x5a);
  assert.equal(nativeKey('Digit0', 'darwin', 'darwin')?.mac, 0x1d);
});

test('Cmd and Ctrl swap between a Mac teacher and a Windows student', () => {
  assert.equal(nativeKey('MetaLeft', 'win32', 'darwin')?.win, 0xa2); // Ctrl
  assert.equal(nativeKey('ControlLeft', 'darwin', 'win32')?.mac, 0x37); // Cmd
  assert.equal(nativeKey('MetaLeft', 'darwin', 'darwin')?.mac, 0x37); // same platform: unchanged
});

test('arrow keys are Windows extended keys; unknown codes are ignored', () => {
  assert.equal(nativeKey('ArrowUp', 'win32', 'win32')?.ext, true);
  assert.equal(nativeKey('NotAKey', 'win32', 'win32'), undefined);
});
