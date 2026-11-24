import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseState } from '../../src/student/input';

test("the input helper's state lines say what remote control can't reach", () => {
  assert.equal(parseState('state secure-desktop'), 'secure-desktop');
  assert.equal(parseState('state elevated\r'), 'elevated');
  assert.equal(parseState('state password-prompt'), 'password-prompt');
  assert.equal(parseState('state ok'), null);
  // Something newer this app doesn't know yet counts as nothing in the way.
  assert.equal(parseState('state something-new'), null);
  // Not a state line: dry-run event logs and the like.
  assert.equal(parseState('key 56 down flags=131072'), undefined);
  assert.equal(parseState(''), undefined);
});
