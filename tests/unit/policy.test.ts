import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyTable } from '../../src/teacher/policy';

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
