// Website filtering: the teacher's rules, how they are cleaned up, and how the
// Chrome/Edge extension turns them into declarativeNetRequest rules.

export interface WebRules {
  /** 'block': these sites are blocked. 'allow': only these sites open. */
  mode: 'block' | 'allow';
  domains: string[];
  /** Close Firefox, Safari & co. while the rules are on, so they can't be used to get around them. */
  closeOtherBrowsers: boolean;
}

/** Native-messaging host the extension connects to (the student app). */
export const NATIVE_HOST = 'school.classmonitor.student';
/** ID of the extension when loaded unpacked from this repo (fixed by the "key" in its manifest). */
export const DEV_EXTENSION_ID = 'lhfcpffeneandjbmhgdgdoajgcloccih';
export const EXTENSION_ID = /^[a-p]{32}$/;
export const MAX_DOMAINS = 200;

/** Browsers the extension doesn't cover, closed by the app blocker while rules are on. */
export const OTHER_BROWSERS = ['firefox', 'safari', 'opera*', 'brave*', 'vivaldi*', 'arc', 'duckduckgo', 'waterfox', 'librewolf', 'tor browser'];

/** "https://www.YouTube.com/watch?v=1" -> "youtube.com"; null if it isn't a site. */
export function normaliseDomain(raw: string): string | null {
  let text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('/') || text.includes(':')) {
    try {
      text = new URL(/^[a-z][a-z\d+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    } catch {
      return null;
    }
  }
  text = text.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (text !== 'localhost' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text)) return null;
  return text;
}

/** Rules from the other side are untrusted: keep only what makes sense. */
export function cleanRules(raw: unknown): WebRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebRules>;
  if (r.mode !== 'block' && r.mode !== 'allow') return null;
  const domains = [...new Set((Array.isArray(r.domains) ? r.domains : []).map((d) => normaliseDomain(String(d))).filter((d): d is string => d !== null))];
  if (!domains.length && r.mode === 'block') return null;
  return { mode: r.mode, domains: domains.slice(0, MAX_DOMAINS), closeOtherBrowsers: r.closeOtherBrowsers !== false };
}

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'allow' } | { type: 'redirect'; redirect: { extensionPath: string } };
  condition: { requestDomains?: string[]; resourceTypes: Array<'main_frame' | 'sub_frame'> };
}

/**
 * Block mode: each listed site (and its subdomains) redirects to the
 * extension's "blocked" page. Allow mode: every page does, except the listed
 * sites. Only pages and frames are filtered, so allowed sites keep their
 * images, scripts and fonts from other domains.
 */
export function toDnrRules(rules: WebRules | null): DnrRule[] {
  if (!rules) return [];
  const blockedPage = (site?: string) => ({
    type: 'redirect' as const,
    redirect: { extensionPath: site ? `/blocked.html?site=${encodeURIComponent(site)}` : '/blocked.html?mode=allow' },
  });
  if (rules.mode === 'block') {
    return rules.domains.map((domain, i) => ({
      id: i + 1,
      priority: 1,
      action: blockedPage(domain),
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] },
    }));
  }
  return [
    { id: 1, priority: 1, action: blockedPage(), condition: { resourceTypes: ['main_frame'] } },
    ...rules.domains.map((domain, i) => ({
      id: i + 2,
      priority: 2,
      action: { type: 'allow' as const },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame' as const] },
    })),
  ];
}
