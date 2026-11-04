import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { StudentInfo } from '../../src/shared/protocol';
import { Roster } from '../../src/teacher/roster';

const info = (id: string, hostname: string): StudentInfo => ({
  id,
  hostname,
  username: 'pupil',
  platform: 'win32',
  screen: { width: 1920, height: 1080 },
  macs: ['aa:bb:cc:dd:ee:ff'],
  displays: [{ id: '1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  version: '0.1.0',
});

test('students seen are saved and come back after a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-')), 'roster.json');
  const roster = new Roster(file);
  roster.seen(info('id-aaaaaaaa', 'PC-01'), '10.0.0.5');
  roster.seen(info('id-bbbbbbbb', 'PC-02'), '10.0.0.6');
  roster.forget('id-bbbbbbbb');
  roster.flush();

  const reloaded = new Roster(file).list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].hostname, 'PC-01');
  assert.equal(reloaded[0].address, '10.0.0.5');
  assert.deepEqual(reloaded[0].macs, ['aa:bb:cc:dd:ee:ff']);
});

test('a corrupt roster file starts empty instead of crashing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-')), 'roster.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(new Roster(file).list(), []);
});
