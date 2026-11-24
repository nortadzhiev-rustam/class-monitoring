import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanLasting, PolicyTable } from '../../src/teacher/policy';

test('a change aimed at everyone also applies to students who join later', () => {
  const table = new PolicyTable();
  assert.deepEqual(table.apply({ ids: ['a'], everyone: true }, { lock: 'Eyes up' }), ['a']);
  assert.equal(table.get('a').lock, 'Eyes up');
  assert.equal(table.get('newcomer').lock, 'Eyes up');
});

test('a change aimed at selected students leaves everyone else alone', () => {
  const table = new PolicyTable();
  const changed = table.apply({ ids: ['a', 'b'], everyone: false }, { lock: 'Stop' });
  assert.deepEqual(changed, ['a', 'b']);
  assert.equal(table.get('c').lock, null);
  assert.equal(table.get('newcomer').lock, null);
});

test('one student can be unlocked while the class stays locked', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['a', 'b'], everyone: true }, { lock: 'Stop' });
  table.apply({ ids: ['a'], everyone: false }, { lock: null });
  assert.equal(table.get('a').lock, null);
  assert.equal(table.get('b').lock, 'Stop');
  assert.equal(table.get('newcomer').lock, 'Stop');
});

test('only students whose policy actually changed are reported', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['a'], everyone: false }, { lock: 'Stop' });
  assert.deepEqual(table.apply({ ids: ['a', 'b'], everyone: false }, { lock: 'Stop' }), ['b']);
});

test('clearing a setting turns it off for everyone it was on for', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['a'], everyone: false }, { broadcast: 's1' });
  table.apply({ ids: ['b'], everyone: true }, { broadcast: 's1', lock: 'Stop' });
  // 'late' joined afterwards and only follows the class default.
  assert.deepEqual(table.clear('broadcast', ['late']).sort(), ['a', 'b', 'late']);
  assert.equal(table.get('a').broadcast, null);
  assert.equal(table.get('newcomer').broadcast, null);
  assert.equal(table.get('b').lock, 'Stop');
});

test('blocked apps, website rules and mute are saved and come back; the rest starts off', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['student-a1', 'student-b2'], everyone: true }, { apps: ['steam*'], lock: 'Stop', mute: true });
  table.apply({ ids: ['student-b2'], everyone: false }, { web: { mode: 'block', domains: ['youtube.com'], closeOtherBrowsers: true } });
  const saved = JSON.parse(JSON.stringify(table.lasting()));
  // student-a1 matches the class default, so only student-b2 is saved on its own.
  assert.deepEqual(Object.keys(saved.students), ['student-b2']);

  const restored = new PolicyTable(saved);
  assert.deepEqual(restored.get('student-a1').apps, ['steam*']);
  assert.equal(restored.get('student-a1').mute, true);
  assert.equal(restored.get('student-a1').lock, null);
  assert.deepEqual(restored.get('student-b2').web?.domains, ['youtube.com']);
  assert.equal(restored.get('student-b2').mute, true);
  assert.deepEqual(restored.get('newcomer').apps, ['steam*']);
  assert.equal(restored.get('newcomer').web, null);
});

test('new class settings end the moment but keep the lasting settings', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['student-a1'], everyone: true }, { apps: ['discord'], lock: 'Stop', poll: { pollId: 'p', question: 'Q?', choices: ['A', 'B'] } });
  table.apply({ ids: ['student-a1'], everyone: false }, { mute: true });
  table.reset();
  assert.equal(table.get('student-a1').lock, null);
  assert.equal(table.get('student-a1').poll, null);
  assert.deepEqual(table.get('student-a1').apps, ['discord']);
  assert.equal(table.get('student-a1').mute, true);
  assert.equal(table.get('newcomer').mute, false);
});

test('saved settings from disk are cleaned up', () => {
  const lasting = cleanLasting({ apps: ['ok app', 'bad/app', 42 as unknown as string], web: { mode: 'nonsense' } as never, mute: 'yes' as never });
  assert.deepEqual(lasting, { apps: ['ok app'], web: null, mute: false });
  // Ids that can't be student ids are dropped.
  const table = new PolicyTable({ everyone: cleanLasting(undefined), students: { '../../etc': { apps: ['x'], web: null, mute: true } } });
  assert.deepEqual(table.lasting().students, {});
});

test('forgetting a computer drops its own settings', () => {
  const table = new PolicyTable();
  table.apply({ ids: ['student-a1'], everyone: false }, { mute: true });
  table.forget('student-a1');
  assert.equal(table.get('student-a1').mute, false);
  assert.deepEqual(table.lasting().students, {});
});
