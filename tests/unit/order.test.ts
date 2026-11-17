import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, cleanOrder, rearrange } from '../../src/teacher/order';

const pcs = (...names: string[]) => names.map((name) => ({ id: name.toLowerCase(), name }));
const names = (items: { name: string }[]) => items.map((i) => i.name);
const byName = (i: { name: string }) => i.name;

test('without a saved order cards sort by name, numbers in number order', () => {
  assert.deepEqual(names(arrange(pcs('PC-10', 'PC-2', 'PC-1'), [], byName)), ['PC-1', 'PC-2', 'PC-10']);
});

test('the saved order wins, and computers not in it follow by name', () => {
  const sorted = arrange(pcs('PC-1', 'PC-2', 'PC-3', 'PC-5', 'PC-4'), ['pc-3', 'pc-1', 'gone'], byName);
  assert.deepEqual(names(sorted), ['PC-3', 'PC-1', 'PC-2', 'PC-4', 'PC-5']);
});

test('rearranging the shown cards keeps hidden ones in their places', () => {
  // a b c d e, with b and d hidden (another group); the teacher drags e first.
  assert.deepEqual(rearrange(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'c']), ['e', 'b', 'a', 'd', 'c']);
  // Everything shown: the new order as is.
  assert.deepEqual(rearrange(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
  // A card that disappeared mid-drag is ignored.
  assert.deepEqual(rearrange(['a', 'b'], ['b', 'x', 'a']), ['b', 'a']);
});

test('saved orders are cleaned: strings only, no repeats', () => {
  assert.deepEqual(cleanOrder(['a', 'b', 'a', 7, null, '', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(cleanOrder('a,b'), []);
  assert.deepEqual(cleanOrder(undefined), []);
});
