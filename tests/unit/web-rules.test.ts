import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressUrl, blocksEverySite, blocksHost, cleanRules, normaliseDomain, toDnrRules } from '../../src/shared/web-rules';

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

test('an empty allow-list blocks every page and says so on the blocked page', () => {
  const rules = { mode: 'allow' as const, domains: [], closeOtherBrowsers: true };
  assert.equal(blocksEverySite(rules), true);
  assert.equal(blocksEverySite({ ...rules, domains: ['wikipedia.org'] }), false);
  assert.equal(blocksEverySite({ ...rules, mode: 'block', domains: ['youtube.com'] }), false);
  assert.equal(blocksEverySite(null), false);
  assert.deepEqual(toDnrRules(rules), [
    {
      id: 1,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?mode=all' } },
      condition: { resourceTypes: ['main_frame'] },
    },
  ]);
  // A real allow-list keeps the "only a few sites" wording.
  const limited = toDnrRules({ ...rules, domains: ['wikipedia.org'] })[0].action;
  assert.deepEqual(limited, { type: 'redirect', redirect: { extensionPath: '/blocked.html?mode=allow' } });
});

test('no rules means no filtering', () => {
  assert.deepEqual(toDnrRules(null), []);
});

test('what an address bar shows becomes a web address, or nothing', () => {
  const host = (text: string) => addressUrl(text)?.hostname ?? null;
  // Chrome hides https:// and www.; Edge and Firefox may show them.
  assert.equal(host('youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(host('https://www.bbc.co.uk/news'), 'www.bbc.co.uk');
  assert.equal(host('http://Example.ORG'), 'example.org');
  assert.equal(host('localhost:3000/app'), 'localhost');
  assert.equal(host('m.youtube.com:443/x'), 'm.youtube.com');
  assert.equal(addressUrl('youtube.com/watch?v=1')?.href, 'https://youtube.com/watch?v=1');
  // Not websites: browser pages, files, plain words, half-typed searches.
  for (const text of ['', '   ', 'chrome://settings', 'edge://newtab', 'about:blank', 'file:///C:/work.html', 'data:text/html,hi',
    'javascript:alert(1)', 'chrome-extension://abc/blocked.html', 'minecraft', 'how to draw a cat', 'view-source:youtube.com']) {
    assert.equal(addressUrl(text), null, text);
  }
});

test('the address watcher blocks the same sites the extension does', () => {
  const block = { mode: 'block' as const, domains: ['youtube.com'], closeOtherBrowsers: true };
  assert.equal(blocksHost(block, 'youtube.com'), true);
  assert.equal(blocksHost(block, 'www.youtube.com'), true);
  assert.equal(blocksHost(block, 'M.YouTube.com.'), true);
  assert.equal(blocksHost(block, 'notyoutube.com'), false);
  assert.equal(blocksHost(block, 'youtube.com.example.org'), false);
  const allow = { mode: 'allow' as const, domains: ['wikipedia.org'], closeOtherBrowsers: true };
  assert.equal(blocksHost(allow, 'en.wikipedia.org'), false);
  assert.equal(blocksHost(allow, 'example.org'), true);
  assert.equal(blocksHost({ ...allow, domains: [] }, 'wikipedia.org'), true);
  assert.equal(blocksHost(null, 'youtube.com'), false);
});
