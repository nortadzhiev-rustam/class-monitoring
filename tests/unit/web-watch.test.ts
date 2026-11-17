import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockPageUrl, isBlockPage, renderBlockPage } from '../../src/student/block-page';
import { macScanScript, parseMacScan } from '../../src/student/web-watch';

const origin = 'http://127.0.0.1:50123';

test('the block page names the site and never blocks itself', () => {
  const url = blockPageUrl(origin, 'www.youtube.com');
  assert.equal(url, 'http://127.0.0.1:50123/blocked?site=www.youtube.com');
  assert.equal(isBlockPage(origin, new URL(url)), true);
  // Another program on another port, or another page, is just a site.
  assert.equal(isBlockPage(origin, new URL('http://127.0.0.1:50124/blocked?site=x.com')), false);
  assert.equal(isBlockPage(origin, new URL('http://127.0.0.1:50123/other')), false);

  const page = renderBlockPage('www.youtube.com', { mode: 'block', domains: ['youtube.com'], closeOtherBrowsers: true });
  assert.match(page, /This site is blocked during class/);
  assert.match(page, /<strong>youtube\.com<\/strong>/);
});

test('the block page fits the rule: allow-list, everything off, or open again', () => {
  const allow = renderBlockPage('example.org', { mode: 'allow', domains: ['wikipedia.org', 'bbc.co.uk'], closeOtherBrowsers: true });
  assert.match(allow, /isn't one of them/);
  assert.match(allow, /href="https:\/\/wikipedia\.org\/"/);
  assert.match(allow, /href="https:\/\/bbc\.co\.uk\/"/);

  const all = renderBlockPage('example.org', { mode: 'allow', domains: [], closeOtherBrowsers: true });
  assert.match(all, /Websites are off during class/);

  const open = renderBlockPage('youtube.com', null);
  assert.match(open, /Websites are open again/);
  assert.match(open, /href="https:\/\/youtube\.com\/"/);
});

test('the block page shows nothing from its address as markup', () => {
  // Anyone can open the page with any ?site=, so it must never become HTML.
  const page = renderBlockPage('<script>alert(1)</script>', { mode: 'block', domains: ['x.com'], closeOtherBrowsers: true });
  assert.doesNotMatch(page, /<script/);
  assert.match(page, /turned off this site/);
});

test('macOS: only the running browsers are asked, and their answer is read back', () => {
  const script = macScanScript([
    { id: 'com.google.Chrome', tab: 'active tab', title: 'title' },
    { id: 'com.apple.Safari', tab: 'current tab', title: 'name' },
  ]);
  assert.match(script, /if application id "com\.google\.Chrome" is running then/);
  assert.match(script, /set t to active tab of w/);
  assert.match(script, /set t to current tab of w/);
  assert.doesNotMatch(script, /edgemac/);

  const F = '\u001f';
  const R = '\u001e';
  const scan = parseMacScan(
    `com.google.Chrome${F}101${F}true${F}https://www.youtube.com/watch?v=1${F}YouTube${R}` +
      `com.google.Chrome${F}102${F}false${F}chrome://newtab/${F}New Tab${R}` +
      `com.apple.Safari${F}7${F}false${F}${F}${R}\n`,
  );
  assert.equal(scan.readable, true);
  assert.deepEqual(scan.tabs, [
    { window: 'com.google.Chrome:101', address: 'https://www.youtube.com/watch?v=1', title: 'YouTube', front: true, editing: false },
    { window: 'com.google.Chrome:102', address: 'chrome://newtab/', title: 'New Tab', front: false, editing: false },
    { window: 'com.apple.Safari:7', address: '', title: null, front: false, editing: false },
  ]);
});

test("macOS: a browser the student said no to means the rules can't reach it", () => {
  const F = '\u001f';
  const R = '\u001e';
  assert.equal(parseMacScan(`com.apple.Safari${F}error${F}-1743${R}`).readable, false);
  // A browser that quit between the check and the question is fine.
  assert.equal(parseMacScan(`com.apple.Safari${F}error${F}-600${R}`).readable, true);
});
