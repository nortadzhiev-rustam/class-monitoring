import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanRules, normaliseDomain, toDnrRules } from '../../src/shared/web-rules';

test('whatever the teacher pastes becomes a bare domain', () => {
  assert.equal(normaliseDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normaliseDomain('www.reddit.com'), 'reddit.com');
  assert.equal(normaliseDomain('*.tiktok.com'), 'tiktok.com');
  assert.equal(normaliseDomain('poki.com/en/g/subway'), 'poki.com');
  assert.equal(normaliseDomain('localhost:3000'), 'localhost');
  assert.equal(normaliseDomain('not a site'), null);
  assert.equal(normaliseDomain('javascript:alert(1)'), null);
  assert.equal(normaliseDomain(''), null);
});

test('rules are cleaned: duplicates, junk and bad modes dropped', () => {
  assert.deepEqual(cleanRules({ mode: 'block', domains: ['YouTube.com', 'www.youtube.com', '???'], closeOtherBrowsers: true }), {
    mode: 'block',
    domains: ['youtube.com'],
    closeOtherBrowsers: true,
  });
  assert.equal(cleanRules({ mode: 'block', domains: [] }), null);
  assert.equal(cleanRules({ mode: 'everything', domains: ['a.com'] }), null);
  assert.equal(cleanRules(null), null);
  // An empty allow-list is meaningful: nothing opens.
  assert.deepEqual(cleanRules({ mode: 'allow', domains: [] }), { mode: 'allow', domains: [], closeOtherBrowsers: true });
});

test('block mode redirects each site, including frames, to the blocked page', () => {
  assert.deepEqual(toDnrRules({ mode: 'block', domains: ['youtube.com'], closeOtherBrowsers: true }), [
    {
      id: 1,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?site=youtube.com' } },
      condition: { requestDomains: ['youtube.com'], resourceTypes: ['main_frame', 'sub_frame'] },
    },
  ]);
});

test('allow mode blocks every page except the allowed sites', () => {
  const rules = toDnrRules({ mode: 'allow', domains: ['wikipedia.org', 'bbc.co.uk'], closeOtherBrowsers: false });
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0].condition, { resourceTypes: ['main_frame'] });
  assert.equal(rules[0].action.type, 'redirect');
  assert.deepEqual(rules.slice(1).map((r) => [r.action.type, r.priority, r.condition.requestDomains]), [
    ['allow', 2, ['wikipedia.org']],
    ['allow', 2, ['bbc.co.uk']],
  ]);
  assert.deepEqual(new Set(rules.map((r) => r.id)).size, 3);
});

test('no rules means no filtering', () => {
  assert.deepEqual(toDnrRules(null), []);
});
