// The page a browser is sent to when the address watcher (web-watch.ts) finds a
// blocked site: served by the student app on this computer only, so it works
// without the browser extension. It reads the teacher's current rules on every
// visit, so reloading it after the rules are lifted offers the site again.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { normaliseDomain, type WebRules } from '../shared/web-rules';

const PATH = '/blocked';

let base: Promise<string> | null = null;

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The page for `site` (as the browser showed it) under these rules; `null` rules: browsing is open again. */
export function renderBlockPage(site: string | null, rules: WebRules | null): string {
  const domain = site ? normaliseDomain(site) : null;
  const name = domain ? `<strong>${escape(domain)}</strong>` : 'this site';
  let title = 'This site is blocked during class';
  let reason = `Your teacher has turned off ${name} for now.`;
  let extra = '<p class="muted">If you need it for your work, ask your teacher.</p>';
  if (!rules) {
    title = 'Websites are open again';
    reason = 'Your teacher has lifted the website rules.';
    extra = domain ? `<p><a class="button" href="https://${escape(domain)}/">Open ${escape(domain)}</a></p>` : '';
  } else if (rules.mode === 'allow' && rules.domains.length === 0) {
    title = 'Websites are off during class';
    reason = 'Your teacher has turned off all websites for now.';
  } else if (rules.mode === 'allow') {
    reason = `Your teacher has limited browsing to a few sites, and ${name} isn't one of them.`;
    const links = rules.domains.map((d) => `<li><a href="https://${escape(d)}/">${escape(d)}</a></li>`).join('');
    extra = `<p class="muted">You can open:</p><ul>${links}</ul>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { --bg: #f5f6f8; --text: #171a1f; --muted: #646b76; --accent: #d33a2c; --accent-soft: #fbe9e7; --chip: #e6e9ee; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #15171c; --text: #e8eaee; --muted: #9aa1ad; --accent: #ff6b5e; --accent-soft: #3d2120; --chip: #262a32; color-scheme: dark; }
}
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
main { max-width: 520px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.badge { display: grid; place-items: center; width: 72px; height: 72px; border-radius: 20px; background: var(--accent-soft); color: var(--accent); }
.badge svg { width: 36px; height: 36px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
h1 { margin: 8px 0 0; font-size: 26px; letter-spacing: -0.01em; }
p { margin: 0; }
.muted { color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
ul a, .button { display: inline-block; padding: 6px 14px; border-radius: 999px; background: var(--chip); color: var(--text); text-decoration: none; }
ul a:hover, .button:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
<div class="badge" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg></div>
<h1>${escape(title)}</h1>
<p>${reason}</p>
${extra}
</main>
</body>
</html>
`;
}

/** Starts the page on a free port of this computer's loopback address (once); resolves to its origin. */
export function startBlockPage(rules: () => WebRules | null): Promise<string> {
  base ??= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET' || url.pathname !== PATH) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(renderBlockPage(url.searchParams.get('site'), rules()));
    });
    server.on('error', (err) => {
      base = null;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return base;
}

/** Where to send a browser that opened `site`. */
export const blockPageUrl = (origin: string, site: string) => `${origin}${PATH}?site=${encodeURIComponent(site)}`;

/** True for the block page itself, which must never be blocked (it would loop). */
export const isBlockPage = (origin: string, url: URL) => url.origin === origin && url.pathname === PATH;
