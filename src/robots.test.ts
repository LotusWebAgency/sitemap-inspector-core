import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockedExample, compileRobots, fetchRobots, matchRobots, MATCH_STEP_BUDGET, MAX_ROBOTS_CHARS, normalizeRobotsPath, parseRobots, parseRobotsGroups,
  productToken, robotsMode, robotsPathOf,
} from './robots.js';

describe('parseRobots', () => {
  it('extracts sitemap directives case-insensitively with resolution and dedupe', () => {
    const text = [
      'User-agent: *', 'Disallow: /admin', '',
      'Sitemap: https://a.com/sitemap.xml',
      'sitemap:   https://a.com/sitemap-news.xml  ',
      'SITEMAP: /relative-sitemap.xml',
      'Sitemap: https://a.com/sitemap.xml',
      'Sitemap: not a url',
    ].join('\n');
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual([
      'https://a.com/sitemap.xml',
      'https://a.com/sitemap-news.xml',
      'https://a.com/relative-sitemap.xml',
    ]);
  });
  it('handles files with no sitemap lines and comment lines', () => {
    expect(parseRobots('# nothing\nUser-agent: *\nAllow: /', 'https://a.com/robots.txt').sitemapUrls).toEqual([]);
  });
  it('reads the keyword with leading whitespace, a space before the colon and any letter case', () => {
    const text = ['  Sitemap: https://a.com/1.xml', 'Sitemap : https://a.com/2.xml', 'sItEmAp:https://a.com/3.xml', '\tSITEMAP\t:\thttps://a.com/4.xml'].join('\n');
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual([
      'https://a.com/1.xml', 'https://a.com/2.xml', 'https://a.com/3.xml', 'https://a.com/4.xml',
    ]);
  });
  it('ignores lines that only contain or extend the keyword', () => {
    const text = [
      'xSitemap: https://a.com/x.xml', 'Sitemapx: https://a.com/y.xml', 'Note: sitemap: https://a.com/z.xml',
      'Disallow: /sitemap: https://a.com/w.xml', '# Sitemap: https://a.com/c.xml', 'Sitemap: https://a.com/ok.xml',
    ].join('\n');
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual(['https://a.com/ok.xml']);
  });
  it('accepts http, any scheme case and root-relative paths, but not other schemes or bare relative paths', () => {
    const text = [
      'Sitemap: http://a.com/h.xml', 'Sitemap: HTTPS://a.com/u.xml', 'Sitemap: /r.xml', 'Sitemap: not/a/url',
      'Sitemap: sitemap.xml/x', 'Sitemap: ftp://a.com/f.xml',
    ].join('\n');
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual(['http://a.com/h.xml', 'https://a.com/u.xml', 'https://a.com/r.xml']);
  });
  it('strips inline comments and drops a # fragment glued into the URL', () => {
    const text = 'Sitemap: https://a.com/s.xml # main\nSitemap: https://a.com/t.xml#frag\nSitemap: # nothing';
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual(['https://a.com/s.xml', 'https://a.com/t.xml']);
  });
  it('drops userinfo and refuses a wildcard host', () => {
    const text = 'Sitemap: https://user:pw@a.com/s.xml\nSitemap: https://*/s.xml\nSitemap: https://*.bank.com/s.xml\nSitemap: https://b.com/ok.xml';
    expect(parseRobots(text, 'https://a.com/robots.txt').sitemapUrls).toEqual(['https://a.com/s.xml', 'https://b.com/ok.xml']);
  });
  it('keeps exactly 500 sitemap urls, the first 500, when more are listed', () => {
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://a.com/s${i}.xml`);
    const parse = (n: number) => parseRobots(urls(n).map((u) => `Sitemap: ${u}`).join('\n'), 'https://a.com/robots.txt').sitemapUrls;
    expect(parse(499)).toEqual(urls(499));
    expect(parse(500)).toEqual(urls(500));
    expect(parse(501)).toEqual(urls(500));
    expect(parse(800)).toEqual(urls(500));
  });
  it('is linear on a long whitespace run inside a value', () => {
    // hang guard only: a quadratic scan of 160,000 spaces would take minutes
    const t0 = performance.now();
    const robotsUrl = 'https://a.com/robots.txt';
    expect(parseRobots('Sitemap: https://a.com/' + ' '.repeat(160_000) + 'x y', robotsUrl).sitemapUrls).toEqual([]);
    expect(parseRobots('Sitemap:' + ' '.repeat(160_000), robotsUrl).sitemapUrls).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

function mockRobots(body: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const res = new Response(body, { status });
    Object.defineProperty(res, 'url', { value: 'https://example.com/robots.txt' });
    return res;
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('productToken', () => {
  it('reduces a user-agent value to its lowercased product token', () => {
    expect(productToken('Googlebot')).toBe('googlebot');
    expect(productToken('Googlebot/2.1')).toBe('googlebot');
    expect(productToken('Googlebot-Image')).toBe('googlebot-image');
    expect(productToken('BINGBOT')).toBe('bingbot');
    expect(productToken('*')).toBe('*');
    expect(productToken('/x')).toBe('');
    expect(productToken('')).toBe('');
  });
  it('trims the value, stops at the first character outside a-z, _ and -, and keeps z and _', () => {
    expect(productToken('  Googlebot ')).toBe('googlebot');
    expect(productToken(' *')).toBe('*');
    expect(productToken('*bot')).toBe('');
    expect(productToken('*foo')).toBe('');
    expect(productToken('** ')).toBe('');
    expect(productToken('bot*')).toBe('bot');
    expect(productToken('zzz')).toBe('zzz');
    expect(productToken('my_bot-1')).toBe('my_bot-');
    expect(productToken('abc{d')).toBe('abc');
    expect(productToken('abc~d')).toBe('abc');
    expect(productToken('abc\u00e9d')).toBe('abc');
    expect(productToken('a1')).toBe('a');
  });
  it('reads * as the wildcard only when the value is exactly *, possibly followed by whitespace', () => {
    expect(productToken('*')).toBe('*');
    expect(productToken('* ')).toBe('*');
    expect(productToken('*\tfoo')).toBe('*');
    expect(productToken('  *  ')).toBe('*');
    const groups = parseRobotsGroups('User-agent: *foo\nDisallow: /secret').groups;
    expect(matchRobots(compileRobots(groups, 'Googlebot'), '/secret', { steps: 0 })).toEqual({ kind: 'allowed' });
  });
  it('folds only ASCII letters, so U+212A (Kelvin sign) is not k', () => {
    expect(productToken('\u212Aeyword')).toBe('');
    expect(productToken('bin\u212A')).toBe('bin');
    expect(productToken('\u212Ab')).not.toBe('kb');
    expect(productToken('GOOGLEBOT')).toBe('googlebot');
  });
});

describe('parseRobotsGroups', () => {
  it('groups consecutive user-agent lines and keeps rules with their line numbers', () => {
    const text = [
      '# crawler access rules',             // 1
      'Disallow: /orphan',                  // 2: before any user-agent, ignored
      'User-agent: Googlebot',              // 3
      'user-agent: Bingbot/2.0',            // 4: same group
      'Disallow: /private/  # comment',     // 5
      'ALLOW: /private/open',               // 6
      'Sitemap: https://example.com/s.xml', // 7: neither starts nor ends a group
      'Disallow: /tmp',                     // 8: still the first group
      '',                                   // 9
      'User-agent: *',                      // 10
      'Disallow:',                          // 11: empty value, no rule
      'Allow: /#x',                         // 12: comment glued on, path is "/"
      'Crawl-delay: 5',                     // 13
      'User-agent: Googlebot-Image',        // 14: after rules, a new group
      'Disallow: /img',                     // 15
    ].join('\r\n');
    expect(parseRobotsGroups(text)).toEqual({ capped: false, groups: [
      { agents: ['googlebot', 'bingbot'], rules: [
        { allow: false, path: '/private/', line: 5 },
        { allow: true, path: '/private/open', line: 6 },
        { allow: false, path: '/tmp', line: 8 },
      ] },
      { agents: ['*'], rules: [{ allow: true, path: '/', line: 12 }] },
      { agents: ['googlebot-image'], rules: [{ allow: false, path: '/img', line: 15 }] },
    ] });
  });

  it('keeps a trailing group that names agents but has no rules', () => {
    expect(parseRobotsGroups('User-agent: *\nDisallow: /\nUser-agent: Googlebot\n').groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/', line: 2 }] },
      { agents: ['googlebot'], rules: [] },
    ]);
  });

  it('drops a rule path over 2,048 chars, groups past 500 and rules past 5,000', () => {
    const long = parseRobotsGroups(`User-agent: *\nDisallow: /${'a'.repeat(2048)}\nDisallow: /${'b'.repeat(2047)}`);
    expect(long.groups[0]!.rules.map((r) => r.path.length)).toEqual([2048]);
    expect(long.capped).toBe(true);

    const many = parseRobotsGroups(Array.from({ length: 501 }, (_, i) => `User-agent: *\nDisallow: /g${i}`).join('\n'));
    expect(many.groups).toHaveLength(500);
    expect(many.groups[499]!.rules.map((r) => r.path)).toEqual(['/g499']); // the 501st group's rule is not adopted
    expect(many.capped).toBe(true);

    const rules = parseRobotsGroups('User-agent: *\n' + Array.from({ length: 5001 }, (_, i) => `Disallow: /r${i}`).join('\n'));
    expect(rules.groups[0]!.rules).toHaveLength(5000);
    expect(rules.capped).toBe(true);

    expect(parseRobotsGroups('User-agent: *\nDisallow: /x').capped).toBe(false);
  });

  it('is linear on a long line and on many short lines', () => {
    // hang guard only: a quadratic parser would take minutes here
    const t0 = performance.now();
    const long = parseRobotsGroups('User-agent: *\nDisallow: /' + ' '.repeat(400_000) + 'x');
    expect(long).toEqual({ groups: [{ agents: ['*'], rules: [] }], capped: true }); // the path is over 2,048 chars: dropped, not cut
    expect(parseRobotsGroups('User-agent: a\n'.repeat(40_000)).groups).toEqual([{ agents: Array(40_000).fill('a'), rules: [] }]);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('ignores a leading BOM and reads keys case-insensitively with space before the colon', () => {
    expect(parseRobotsGroups('\uFEFFUSER-AGENT: Googlebot\nDisallow : /x\nALLOW :/y').groups).toEqual([
      { agents: ['googlebot'], rules: [{ allow: false, path: '/x', line: 2 }, { allow: true, path: '/y', line: 3 }] },
    ]);
  });

  it('skips a line without a colon, whatever its text', () => {
    expect(parseRobotsGroups('User-agent: *\nAllowx\nDisallowx\nUser-agentx\nDisallow: /ok').groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/ok', line: 5 }] },
    ]);
  });

  it('does not flag exactly 500 groups or exactly 5,000 rules as capped', () => {
    const groups = parseRobotsGroups(Array.from({ length: 500 }, (_, i) => `User-agent: *\nDisallow: /g${i}`).join('\n'));
    expect(groups.groups).toHaveLength(500);
    expect(groups.capped).toBe(false);
    const rules = parseRobotsGroups('User-agent: *\n' + Array.from({ length: 5000 }, (_, i) => `Disallow: /r${i}`).join('\n'));
    expect(rules.groups[0]!.rules).toHaveLength(5000);
    expect(rules.capped).toBe(false);
  });
});

describe('parseRobots lines and length', () => {
  const at = 'https://a.com/robots.txt';
  it('splits on CR, LF and CRLF like parseRobotsGroups does', () => {
    const urls = ['https://a.com/1.xml', 'https://a.com/2.xml', 'https://a.com/3.xml'];
    for (const sep of ['\r', '\n', '\r\n']) {
      const text = `User-agent: *${sep}Disallow: /x${sep}Sitemap: ${urls[0]}${sep}Sitemap: ${urls[1]}${sep}Sitemap: ${urls[2]}`;
      expect(parseRobots(text, at).sitemapUrls, JSON.stringify(sep)).toEqual(urls);
    }
  });
  it('drops a Sitemap URL longer than 2,048 chars and keeps one of exactly 2,048', () => {
    const exact = 'https://a.com/' + 'x'.repeat(2048 - 'https://a.com/'.length);
    const text = [`Sitemap: ${exact}`, `Sitemap: ${exact}y`, 'Sitemap: https://a.com/ok.xml'].join('\n');
    expect(parseRobots(text, at).sitemapUrls).toEqual([exact, 'https://a.com/ok.xml']);
  });
});

describe('robotsMode', () => {
  const base = { url: 'https://example.com/robots.txt', sitemapUrls: [] };
  it('classifies fetch outcomes', () => {
    expect(robotsMode(null)).toBe('unverified');
    expect(robotsMode({ ...base, found: true, status: 200, groups: [] })).toBe('rules');
    for (const status of [500, 503, 429]) expect(robotsMode({ ...base, found: false, status }), String(status)).toBe('unverified');
    for (const status of [400, 401, 403, 404, 410, 200, 302]) expect(robotsMode({ ...base, found: false, status }), String(status)).toBe('allow-all');
  });
  it('treats robots data stored before RobotsInfo.groups existed as legacy', () => {
    expect(robotsMode({ ...base, found: true })).toBe('legacy');
    expect(robotsMode({ ...base, found: false })).toBe('legacy');
    expect(robotsMode({ ...base, found: true, status: 200 })).toBe('legacy');
  });
});

describe('fetchRobots', () => {
  it('keeps the status and the parsed groups', async () => {
    mockRobots('User-agent: *\nDisallow: /private\nSitemap: https://example.com/s.xml\n');
    expect(await fetchRobots('https://example.com')).toEqual({
      found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: ['https://example.com/s.xml'],
      groups: [{ agents: ['*'], rules: [{ allow: false, path: '/private', line: 2 }] }],
    });
  });
  it('keeps the status of an error response, without groups', async () => {
    mockRobots('busy', 503);
    expect(await fetchRobots('https://example.com')).toEqual({ found: false, url: 'https://example.com/robots.txt', status: 503, sitemapUrls: [] });
  });
  it('returns null when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    expect(await fetchRobots('https://example.com')).toBeNull();
  });
  it('answers null (unverified) when a read fails halfway', async () => {
    let sent = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const res = new Response(new ReadableStream<Uint8Array>({
        pull(c) { if (sent) c.error(new TypeError('reset')); else { sent = true; c.enqueue(new TextEncoder().encode('User-agent: *\n')); } },
      }), { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://example.com/robots.txt' });
      return res;
    }));
    expect(await fetchRobots('https://example.com')).toBeNull();
    expect(sent).toBe(true);
  });
  // Like the real one, the stub errors the body with the signal's reason on abort; pieces are dripped `every` ms apart.
  function dripRobots(every: number, seen: { signal?: AbortSignal } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      seen.signal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) { signal.addEventListener('abort', () => { c.error(signal.reason); }, { once: true }); },
        async pull(c) { await new Promise((r) => setTimeout(r, every)); if (!signal.aborted) c.enqueue(new TextEncoder().encode('#')); },
      });
      const res = new Response(body, { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://example.com/robots.txt' });
      return res;
    }));
  }
  it('stops reading when the scan signal aborts, answering null', async () => {
    vi.useFakeTimers();
    try {
      const seen: { signal?: AbortSignal } = {};
      dripRobots(5, seen);
      const scan = new AbortController();
      const p = fetchRobots('https://example.com', { signal: scan.signal });
      await vi.advanceTimersByTimeAsync(30);
      expect(seen.signal!.aborted).toBe(false); // still reading
      scan.abort(new DOMException('time limit', 'TimeoutError'));
      expect(await p).toBeNull();
      expect(seen.signal!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('gives up on a robots.txt that drips bytes for more than 30 s, though every piece beats the idle limit', async () => {
    vi.useFakeTimers();
    try {
      dripRobots(5_000);
      let result: unknown = 'pending';
      void fetchRobots('https://example.com').then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(result).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('reads a CR-only robots.txt: sitemaps and rules', async () => {
    mockRobots('User-agent: *\rDisallow: /private\rSitemap: https://example.com/s.xml\r');
    const info = await fetchRobots('https://example.com');
    expect(info).toEqual({
      found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: ['https://example.com/s.xml'],
      groups: [{ agents: ['*'], rules: [{ allow: false, path: '/private', line: 2 }] }],
    });
  });
  it('does not treat a body of exactly the read cap as cut', async () => {
    const head = 'User-agent: *\nDisallow: /last #';
    mockRobots(head + 'x'.repeat(MAX_ROBOTS_CHARS - head.length));
    expect(await fetchRobots('https://example.com')).toEqual({
      found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: [],
      groups: [{ agents: ['*'], rules: [{ allow: false, path: '/last', line: 2 }] }],
    });
  });
  it('cuts a body one char over the read cap at the last line break and flags it capped', async () => {
    const head = 'User-agent: *\nDisallow: /last #';
    mockRobots(head + 'x'.repeat(MAX_ROBOTS_CHARS + 1 - head.length));
    expect(await fetchRobots('https://example.com')).toEqual({
      found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: [],
      groups: [{ agents: ['*'], rules: [] }], capped: true, // the long last line was cut, so its rule is dropped, never shortened
    });
  });
  it('releases the body when the read cap stops the read early', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const res = new Response(new ReadableStream<Uint8Array>({
        pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024))); },
        cancel() { cancelled = true; },
      }), { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://example.com/robots.txt' });
      return res;
    }));
    const info = await fetchRobots('https://example.com');
    expect(info?.capped).toBe(true);
    await vi.waitFor(() => { expect(cancelled).toBe(true); });
  });
  it('drops the partial last line when the read cap cuts the body', async () => {
    const head = 'User-agent: *\nDisallow: /kept\n#';
    const pad = 'x'.repeat(MAX_ROBOTS_CHARS - 13 - head.length - 1) + '\n';
    // the cap falls 13 chars into the next line, after "Disallow: /ab"
    mockRobots(head + pad + 'Disallow: /abcdef\n');
    expect(await fetchRobots('https://example.com')).toEqual({
      found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: [],
      groups: [{ agents: ['*'], rules: [{ allow: false, path: '/kept', line: 2 }] }], capped: true,
    });
  });
});

describe('step budget', () => {
  it('measures 100 and 200 URLs against 2,000 same-bucket prefix rules, then extrapolates the cost to 50,000 as staying under the budget (the old 100M budget did not)', () => {
    const text = 'User-agent: *\n' + Array.from({ length: 2000 }, (_, i) => `Disallow: /private-${i}/`).join('\n');
    const compiled = compileRobots(parseRobotsGroups(text).groups, 'Googlebot');
    const url = (i: number) => `/products/category-${String(i % 100).padStart(3, '0')}/item-${String(i % 100).padStart(5, '0')}`;
    const run = (count: number) => {
      const meter = { steps: 0 };
      for (let i = 0; i < count; i++) expect(matchRobots(compiled, url(i), meter)).toEqual({ kind: 'allowed' });
      return meter.steps;
    };
    const hundred = run(100);
    expect(run(200)).toBe(2 * hundred); // linear in the number of URLs: every cycle of 100 costs the same
    const floor = 100 * (2 * url(0).length + 64 + 2000); // the path twice, the call constant, one step for each of the 2,000 rules
    expect(hundred).toBeGreaterThanOrEqual(floor);
    expect(hundred).toBeLessThan(floor * 1.5); // the digits in a path now and then collide with a rule character in the prefilter
    expect(500 * hundred).toBeGreaterThan(100_000_000);
    expect(500 * hundred).toBeLessThan(MATCH_STEP_BUDGET);
  });
});

const ORIGIN = 'https://example.com';
const rulesFor = (text: string, agent = 'Googlebot') => compileRobots(parseRobotsGroups(text).groups, agent);
const kind = (text: string, path: string, agent?: string) => matchRobots(rulesFor(text, agent), path, { steps: 0 }).kind;

describe('normalizeRobotsPath', () => {
  it('normalizes escapes, non-ASCII and stray percent signs', () => {
    expect(normalizeRobotsPath('/a%2fb')).toBe('/a%2Fb');       // reserved: stays encoded, hex uppercased
    expect(normalizeRobotsPath('/%41%7e%2D')).toBe('/A~-');      // unreserved: decoded
    expect(normalizeRobotsPath('/café')).toBe('/caf%C3%A9');
    expect(normalizeRobotsPath('/caf%c3%a9')).toBe('/caf%C3%A9');
    expect(normalizeRobotsPath('/100%')).toBe('/100%25');
    expect(normalizeRobotsPath('/%zz')).toBe('/%25zz');
    expect(normalizeRobotsPath('/a b\t')).toBe('/a%20b%09');
    expect(normalizeRobotsPath('/x\uD800')).toBe('/x%EF%BF%BD'); // lone surrogate: replacement character, no throw
    expect(normalizeRobotsPath('/*.pdf$')).toBe('/*.pdf$');
    expect(normalizeRobotsPath('/a%2a%24')).toBe('/a%2A%24');    // encoded * and $ stay literal
  });

  it('decodes an escape of every unreserved character, at the edge of each range', () => {
    expect(normalizeRobotsPath('/%41%5A%5a%61%7A%7a%30%39%2E%2e%5F%5f%7E%7e%2D')).toBe('/AZZazz09..__~~-');
    expect(normalizeRobotsPath('/%40%5B%60%7B%2F%3A%2C')).toBe('/%40%5B%60%7B%2F%3A%2C');
  });

  it('turns a % without two hex digits after it into %25 and reads digits of either case', () => {
    expect(normalizeRobotsPath('/%4z')).toBe('/%254z');
    expect(normalizeRobotsPath('/%z4')).toBe('/%25z4');
    expect(normalizeRobotsPath('/%0:')).toBe('/%250:');
    expect(normalizeRobotsPath('/%0Z')).toBe('/%250Z');
    expect(normalizeRobotsPath('/%0a/%0A/%00')).toBe('/%0A/%0A/%00');
    expect(normalizeRobotsPath('/%fF')).toBe('/%FF');
    expect(normalizeRobotsPath('/%')).toBe('/%25');
    expect(normalizeRobotsPath('/%4')).toBe('/%254');
  });

  it('escapes DEL and the space, but not the printable characters around them', () => {
    expect(normalizeRobotsPath('/a\x7fb c~!')).toBe('/a%7Fb%20c~!');
    expect(normalizeRobotsPath('/\x1f\x20\x21')).toBe('/%1F%20!');
  });

  it('escapes the ASCII characters URL parsers may escape, so both spellings agree', () => {
    expect(normalizeRobotsPath('/x{y}')).toBe('/x%7By%7D');
    expect(normalizeRobotsPath('/*?q=\'x\'')).toBe('/*?q=%27x%27');
    expect(normalizeRobotsPath('/"<>`^|')).toBe('/%22%3C%3E%60%5E%7C');
    expect(normalizeRobotsPath('/%7by%7D')).toBe('/%7By%7D');
  });

  it('gives the same string for a raw character and for what new URL() makes of it', () => {
    // Every printable ASCII character, in the path and in the query ('?', '#', '%' and '\' change the URL's shape).
    for (let code = 0x20; code < 0x7f; code++) {
      const c = String.fromCharCode(code);
      if ('?#%\\'.includes(c)) continue;
      const raw = `/a${c}b?q${c}x`;
      const u = new URL(`${ORIGIN}${raw}`);
      expect(normalizeRobotsPath(u.pathname + u.search), JSON.stringify(c)).toBe(normalizeRobotsPath(raw));
    }
    const u = new URL(`${ORIGIN}/x{y}?q='x'`);
    expect(u.pathname).toBe('/x%7By%7D');
    expect(u.search).toBe('?q=%27x%27');
  });
});

describe('robotsPathOf', () => {
  it('reads a URL on one of the aliases like a URL on the origin', () => {
    const aliases = ['https://prod.example'];
    expect(robotsPathOf('https://prod.example/a?x=1', ORIGIN, aliases)).toBe('/a?x=1');
    expect(robotsPathOf('https://prod.example/a', ORIGIN)).toBeNull();
    expect(robotsPathOf('https://other.example/a', ORIGIN, aliases)).toBeNull();
  });
  it('returns path and query for http(s) URLs on exactly the origin', () => {
    expect(robotsPathOf('https://example.com/a/b?x=1#frag', ORIGIN)).toBe('/a/b?x=1');
    expect(robotsPathOf('https://example.com', ORIGIN)).toBe('/');
    expect(robotsPathOf('https://example.com:443/a', ORIGIN)).toBe('/a');
    expect(robotsPathOf(new URL('https://example.com/café'), ORIGIN)).toBe('/caf%C3%A9');
    for (const other of ['https://www.example.com/a', 'http://example.com/a', 'https://example.com:8443/a', 'https://cdn.example.net/a', 'ftp://example.com/a', 'not a url']) {
      expect(robotsPathOf(other, ORIGIN), other).toBeNull();
    }
  });
  it('refuses a scheme other than http(s) even when its origin equals the one asked for', () => {
    expect(robotsPathOf('ftp://example.com/a', 'ftp://example.com')).toBeNull();
    expect(robotsPathOf('ftp://example.com/a', ORIGIN, ['ftp://example.com'])).toBeNull();
  });
});

describe('matchRobots', () => {
  it('picks the longest matching rule, Allow on a tie', () => {
    const text = 'User-agent: *\nDisallow: /shop\nAllow: /shop/public\nDisallow: /shop/public/drafts\nAllow: /page\nDisallow: /page';
    expect(matchRobots(rulesFor(text), '/shop/cart', { steps: 0 })).toEqual({ kind: 'blocked', rule: { allow: false, path: '/shop', line: 2 } });
    expect(kind(text, '/shop/public/item')).toBe('allowed');
    expect(kind(text, '/shop/public/drafts/1')).toBe('blocked');
    expect(kind(text, '/page')).toBe('allowed');
    expect(kind(text, '/other')).toBe('allowed');
    expect(kind('User-agent: *\nAllow: /\nDisallow: /about', '/about')).toBe('blocked');
  });

  it('supports * anywhere and $ only at the end', () => {
    const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\nDisallow: /exact$\nDisallow: /a$b\nDisallow: /*/end$';
    expect(kind(text, '/docs/file.pdf')).toBe('blocked');
    expect(kind(text, '/docs/file.pdf?x=1')).toBe('allowed');
    expect(kind(text, '/tmp/x/cache/1')).toBe('blocked');
    expect(kind(text, '/tmpcache')).toBe('allowed');
    expect(kind(text, '/exact')).toBe('blocked');
    expect(kind(text, '/exact/more')).toBe('allowed');
    expect(kind(text, '/a$b/c')).toBe('blocked');     // a $ before the end is a literal character
    expect(kind(text, '/x/y/end')).toBe('blocked');
    expect(kind(text, '/x/end/z')).toBe('allowed');
  });

  it('reports the earliest rule of a specificity tie, whichever bucket it sits in', () => {
    // '/*x' has no literal second character (wild bucket), '/a*' is bucketed under 'a'; both are 3 long and match /ax
    const text = 'User-agent: *\nDisallow: /*x\nDisallow: /a*';
    expect(matchRobots(rulesFor(text), '/ax', { steps: 0 })).toEqual({ kind: 'blocked', rule: { allow: false, path: '/*x', line: 2 } });
    expect(matchRobots(rulesFor('User-agent: *\nDisallow: /a*\nDisallow: /*x'), '/ax', { steps: 0 })).toEqual({ kind: 'blocked', rule: { allow: false, path: '/a*', line: 2 } });
    const split = 'User-agent: *\nDisallow: /*x\n\nUser-agent: *\nDisallow: /a*';
    expect(matchRobots(rulesFor(split), '/ax', { steps: 0 })).toMatchObject({ rule: { line: 2 } });
  });

  it('lets Allow win a tie whichever rule is listed first', () => {
    expect(matchRobots(rulesFor('User-agent: *\nDisallow: /page\nAllow: /page'), '/page', { steps: 0 })).toEqual({
      kind: 'allowed', rule: { allow: true, path: '/page', line: 3 },
    });
    expect(matchRobots(rulesFor('User-agent: *\nAllow: /page\nDisallow: /page'), '/page', { steps: 0 })).toEqual({
      kind: 'allowed', rule: { allow: true, path: '/page', line: 2 },
    });
    const mixed = 'User-agent: *\nDisallow: /a*\nDisallow: /*b\nAllow: /a*\nAllow: /*b\nDisallow: /*c';
    expect(kind(mixed, '/ab')).toBe('allowed');
    expect(kind(mixed, '/xc')).toBe('blocked');
    expect(matchRobots(rulesFor('User-agent: *\nDisallow: /x\nAllow: /x\nDisallow: /x'), '/x/y', { steps: 0 })).toEqual({
      kind: 'allowed', rule: { allow: true, path: '/x', line: 3 },
    });
  });

  it('matches a star at the start against a path that starts with the next part', () => {
    expect(kind('User-agent: *\nDisallow: */admin/*', '/admin/x')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: */admin/*', '/a/admin/x')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: */admin/*', '/admin')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: */x', '/x')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: */x', '/y/x')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: */x', '/y')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: *a*b', 'ab')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: *ab', 'abc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: *abc$', 'abc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: *abc$', 'abcd')).toBe('allowed');
  });

  it('does not let a part before the $ anchor overlap the anchored suffix', () => {
    expect(kind('User-agent: *\nDisallow: /*ab*bc$', '/xabc')).toBe('allowed'); // 'ab' and 'bc' would share the 'b'
    expect(kind('User-agent: *\nDisallow: /*ab*bc$', '/xabbc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*ab*bc$', '/xabxbc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /ab*bc$', '/abbc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /ab*bc$', '/abc')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /a*a$', '/a')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /a*a$', '/aa')).toBe('blocked');
  });

  it('finds a part after a partial match of itself (KMP failure links)', () => {
    expect(kind('User-agent: *\nDisallow: /*abac', '/ababac')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*abac', '/ababab')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /*abac$', '/ababac')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*a*b*ababc', '/ababababc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*ab*ababc', '/ababababc')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*ab*ababc', '/abababab')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /*aabaaab', '/aabaaaabaaab')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*aabaaab*x', '/aabaaaabaaabx')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*aaab', '/aaaab')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*aabaac', '/aabaabaac')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: /*aabb', '/aababb')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /*aabaaaa', '/aabaaabaaaa')).toBe('blocked');
  });

  it('agrees with a reference wildcard model on random multi-character parts', () => {
    const reference = (p: string) => {
      const anchored = p.endsWith('$');
      const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.$]/g, '\\$&')).join('.*');
      return new RegExp('^' + body + (anchored ? '$' : ''));
    };
    let seed = 11;
    const rand = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const word = (alphabet: string, min: number, max: number) => Array.from({ length: min + rand(max - min + 1) }, () => alphabet.charAt(rand(alphabet.length))).join('');
    for (let i = 0; i < 4000; i++) {
      const parts = Array.from({ length: 1 + rand(3) }, () => word('ab', 1, 7));
      const pattern = '/' + parts.join('*') + (rand(3) === 0 ? '$' : '');
      const path = '/' + word(rand(2) === 0 ? 'ab' : 'abc', 0, 16);
      const expected = reference(pattern).test(path) ? 'blocked' : 'allowed';
      expect(kind(`User-agent: *\nDisallow: ${pattern}`, path), `${pattern} vs ${path}`).toBe(expected);
    }
  });

  it('never matches a rule whose pattern starts with neither / nor *, even for a path without a leading slash', () => {
    expect(matchRobots(rulesFor('User-agent: *\nDisallow: private'), 'private', { steps: 0 })).toEqual({ kind: 'allowed' });
  });

  describe('step accounting', () => {
    const callCost = (path: string) => 2 * path.length + 64;
    const probe = (rules: string[], path: string) => {
      const meter = { steps: 0 };
      const verdict = matchRobots(rulesFor('User-agent: *\n' + rules.map((r) => `Disallow: ${r}`).join('\n')), path, meter);
      return { kind: verdict.kind, steps: meter.steps };
    };

    it('skips a rule for one step when the path lacks a character the rule needs, in either half of the mask', () => {
      expect(probe(['/*a'], '/AAA')).toEqual({ kind: 'allowed', steps: callCost('/AAA') + 1 });
      expect(probe(['/*A'], '/bbb')).toEqual({ kind: 'allowed', steps: callCost('/bbb') + 1 });
      expect(probe(['/*a*b'], '/bbbb')).toEqual({ kind: 'allowed', steps: callCost('/bbbb') + 1 });
      expect(probe(['/*b*a'], '/bbbb')).toEqual({ kind: 'allowed', steps: callCost('/bbbb') + 1 });
    });

    it('skips a rule for one step when the path is shorter than its literal parts together', () => {
      expect(probe(['/*aa*bb'], '/ab')).toEqual({ kind: 'allowed', steps: callCost('/ab') + 1 });
      expect(probe(['/*aa*bb$'], '/ab')).toEqual({ kind: 'allowed', steps: callCost('/ab') + 1 });
    });

    it('looks only at rules in the bucket of the path second character, plus the wildcard-led ones', () => {
      expect(probe(['/a'], '/z')).toEqual({ kind: 'allowed', steps: callCost('/z') });
      expect(probe(['/a', '/b/', '/ab'], '/c')).toEqual({ kind: 'allowed', steps: callCost('/c') });
      expect(probe(['/a', '/*z'], '/z')).toEqual({ kind: 'blocked', steps: callCost('/z') + 4 + 1 + 1 }); // 4 per rule, '/' prefix, 'z' part
    });

    it('charges one step for an empty last part and the compared characters for prefix and suffix checks', () => {
      expect(probe(['/a*'], '/ab')).toEqual({ kind: 'blocked', steps: callCost('/ab') + 4 + 2 + 1 });
      expect(probe(['/ab'], '/abc')).toEqual({ kind: 'blocked', steps: callCost('/abc') + 4 + 3 });
      expect(probe(['/abc'], '/acb')).toEqual({ kind: 'allowed', steps: callCost('/acb') + 4 + 3 }); // diverges at the 3rd character
      expect(probe(['/*abc$'], '/xabc')).toEqual({ kind: 'blocked', steps: callCost('/xabc') + 4 + 1 + 3 });
      expect(probe(['/*abc$'], '/abcab')).toEqual({ kind: 'allowed', steps: callCost('/abcab') + 4 + 1 + 1 }); // diverges at the last character
      expect(probe(['/*abc$'], '/abxbc')).toEqual({ kind: 'allowed', steps: callCost('/abxbc') + 4 + 1 + 3 });
      expect(probe(['/*xbc$'], '/abcbc')).toEqual({ kind: 'allowed', steps: callCost('/abcbc') + 1 }); // no x in the path
    });

    it('charges one step per comparison of a part search, failure links included', () => {
      // a b a | b: fails against 'c', falls back to 'ab' (1 link step), then a, c: 3 + 2 + 1 + 1 = 7
      expect(probe(['/*abac'], '/ababac')).toEqual({ kind: 'blocked', steps: callCost('/ababac') + 4 + 1 + 7 });
      expect(probe(['/*abac'], '/ababab')).toEqual({ kind: 'allowed', steps: callCost('/ababab') + 1 });
    });
  });

  it('stays within the budget check exactly: a meter at the budget is still served, one past it is not', () => {
    const empty = rulesFor('');
    expect(matchRobots(empty, '/x', { steps: MATCH_STEP_BUDGET })).toEqual({ kind: 'allowed' });
    expect(matchRobots(empty, '/x', { steps: MATCH_STEP_BUDGET + 1 })).toEqual({ kind: 'over-limit' });
    const one = rulesFor('User-agent: *\nDisallow: /ab');
    const exact = { steps: MATCH_STEP_BUDGET - (2 * '/a'.length + 64) };
    expect(matchRobots(one, '/a', exact)).toEqual({ kind: 'allowed' }); // the call lands on the budget, the rule check passes
    expect(exact.steps).toBe(MATCH_STEP_BUDGET + 1);
    expect(matchRobots(one, '/a', { steps: MATCH_STEP_BUDGET - (2 * '/a'.length + 64) + 1 })).toEqual({ kind: 'over-limit' });
  });

  it('words the example of a blocking Allow rule and of a Disallow rule', () => {
    expect(blockedExample('https://a.com/x', { allow: false, path: '/x', line: 4 })).toEqual({
      value: 'https://a.com/x: blocked by "Disallow: /x" (robots.txt line 4)',
      code: 'robots-rule',
      params: { url: 'https://a.com/x', rule: 'Disallow: /x', robotsLine: '4' },
    });
    expect(blockedExample('https://a.com/x', { allow: true, path: '/x', line: 7 }).params).toEqual({
      url: 'https://a.com/x', rule: 'Allow: /x', robotsLine: '7',
    });
  });

  it('merges the groups of an agent and falls back to *', () => {
    const text = [
      'User-agent: *', 'Disallow: /all',
      'User-agent: Googlebot', 'Disallow: /g1',
      'User-agent: Googlebot-Image', 'Disallow: /img',
      'User-agent: googlebot', 'Disallow: /g2',
    ].join('\n');
    expect(kind(text, '/g1')).toBe('blocked');
    expect(kind(text, '/g2')).toBe('blocked');            // both googlebot groups apply
    expect(kind(text, '/all')).toBe('allowed');           // googlebot has its own groups, so * does not apply
    expect(kind(text, '/img')).toBe('allowed');           // googlebot-image is another agent
    expect(kind(text, '/all', 'Bingbot')).toBe('blocked'); // no bingbot group: the * group applies
    expect(kind(text, '/g1', 'Bingbot')).toBe('allowed');
    expect(kind(text, '/all', '*')).toBe('blocked');
  });

  it('allows everything when the agent has a group without rules or no group applies', () => {
    expect(kind('User-agent: *\nDisallow: /\nUser-agent: Googlebot\n', '/x')).toBe('allowed');
    expect(kind('User-agent: Bingbot\nDisallow: /', '/x')).toBe('allowed');
    expect(kind('', '/x')).toBe('allowed');
  });

  it('always allows /robots.txt, and never matches a pattern that starts with neither / nor *', () => {
    expect(kind('User-agent: *\nDisallow: /', '/robots.txt')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: /', '/robots.txt.bak')).toBe('blocked');
    expect(kind('User-agent: *\nDisallow: private', '/private')).toBe('allowed');
    expect(kind('User-agent: *\nDisallow: *private', '/x/private')).toBe('blocked');
  });

  it('matches raw and encoded forms of the same path', () => {
    const text = 'User-agent: *\nDisallow: /café\nDisallow: /a%2fb\nDisallow: /%7Euser';
    expect(kind(text, robotsPathOf('https://example.com/café', ORIGIN)!)).toBe('blocked');
    expect(kind(text, '/caf%c3%a9/menu')).toBe('blocked');
    expect(kind(text, '/a%2Fb')).toBe('blocked');
    expect(kind(text, '/a/b')).toBe('allowed');          // an encoded slash is not a slash
    expect(kind(text, '/~user/page')).toBe('blocked');   // an unreserved escape equals its character
  });

  it("matches characters the URL parser escapes, written raw or escaped, on either side", () => {
    const text = 'User-agent: *\nDisallow: /*?q=\'x\'\nDisallow: /x{y}\nDisallow: /p%7Cq';
    for (const url of [`${ORIGIN}/s?q='x'`, `${ORIGIN}/s?q=%27x%27`, `${ORIGIN}/s/t?q='x'`]) {
      expect(kind(text, robotsPathOf(url, ORIGIN)!), url).toBe('blocked');
    }
    expect(kind(text, robotsPathOf(`${ORIGIN}/s?q=x`, ORIGIN)!)).toBe('allowed');
    for (const url of [`${ORIGIN}/x{y}/z`, `${ORIGIN}/x%7By%7D/z`, `${ORIGIN}/x%7by%7d/z`, `${ORIGIN}/p|q`, `${ORIGIN}/p%7Cq`]) {
      expect(kind(text, robotsPathOf(url, ORIGIN)!), url).toBe('blocked');
    }
    expect(kind(text, '/x{y}/z')).toBe('blocked');       // a raw, unparsed path works too
    expect(kind(text, robotsPathOf(`${ORIGIN}/x/y`, ORIGIN)!)).toBe('allowed');
  });

  it('agrees with a reference wildcard model on random patterns', () => {
    // Test-only reference built as a RegExp from synthetic patterns; production code never builds one from robots.txt.
    const reference = (p: string) => {
      const anchored = p.endsWith('$');
      const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.$]/g, '\\$&')).join('.*');
      return new RegExp('^' + body + (anchored ? '$' : ''));
    };
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const pick = (alphabet: string, max: number) => Array.from({ length: rand(max + 1) }, () => alphabet.charAt(rand(alphabet.length))).join('');
    for (let i = 0; i < 3000; i++) {
      const pattern = '/' + pick('ab*$', 6);
      const path = '/' + pick('ab$', 8);
      const expected = reference(pattern).test(path) ? 'blocked' : 'allowed';
      expect(kind(`User-agent: *\nDisallow: ${pattern}`, path), `${pattern} vs ${path}`).toBe(expected);
    }
  });

  it('keeps wildcard-heavy patterns within a step bound proportional to rules and path length', () => {
    // 49 rules of ~2,000 chars (1,001 parts each, just under the part cap); each has every character the path has, so the
    // prefilter lets it through, and none matches, so every check scans the whole path
    const rules = 49;
    const text = 'User-agent: *\n' + Array.from({ length: rules }, (_, i) => `Disallow: /${'*a'.repeat(1000)}*b${i}`).join('\n');
    const compiled = rulesFor(text);
    const meter = { steps: 0 };
    const path = '/' + 'a'.repeat(2000) + '0123456789b';
    const calls = 100;
    for (let i = 0; i < calls; i++) expect(matchRobots(compiled, path, meter).kind).toBe('allowed');
    // per call: the path twice (normalized, masked), then per rule at most 2 comparisons per path character plus a constant
    const perCall = 200 + 2 * path.length + rules * (2 * path.length + 20);
    expect(meter.steps).toBeGreaterThan(calls * rules * path.length);
    expect(meter.steps).toBeLessThanOrEqual(calls * perCall);
    expect(meter.steps).toBeLessThan(MATCH_STEP_BUDGET);
  });

  it('meters runs of consecutive stars in proportion to the work they cost', () => {
    const rules = 24; // 2,031 parts each, just under the part cap
    const stars = '*'.repeat(2030);
    const path = '/aaaaaaaaaa0123456789b'; // has the characters every rule needs, matches none
    const ruleLines = (suffix: (i: number) => string) => 'User-agent: *\n' + Array.from({ length: rules }, (_, i) => `Disallow: /${stars}${suffix(i)}`).join('\n');
    for (const [label, text] of [['anchored', ruleLines((i) => `b${i}$`)], ['open', ruleLines((i) => `b${i}`)]] as const) {
      const compiled = rulesFor(text);
      const one = { steps: 0 };
      matchRobots(compiled, path, one);
      const many = { steps: 0 };
      for (let i = 0; i < 200; i++) matchRobots(compiled, path, many);
      expect(many.steps, label).toBe(200 * one.steps); // deterministic: every call costs the same
      // the empty parts between stars are dropped at compile time; every rule examined in full costs at least RULE_STEP_COST (4) on top of the per-call cost
      expect(one.steps, label).toBeGreaterThanOrEqual(2 * path.length + 64 + rules * 4);
      expect(one.steps, label).toBeLessThanOrEqual(rules * 40 + 200);
    }
  });

  it('meters compared characters: 5,000 prefix rules over thousands of URLs stay within budget', () => {
    const tail = 't'.repeat(80);
    const rules = 5000;
    const compiled = rulesFor('User-agent: *\n' + Array.from({ length: rules }, (_, i) => `Disallow: /s-${i}-${tail}`).join('\n'));
    const meter = { steps: 0 };
    const urls = 2500;
    for (let i = 0; i < urls; i++) {
      const path = `/s-${i * 2}-${tail}/page`;
      expect(matchRobots(compiled, path, meter).kind).toBe('blocked');
      expect(matchRobots(compiled, `/blog/${i}`, meter).kind).toBe('allowed');
    }
    // a rule diverges from a path within "/s-" plus 4 digits and the dash: about 9 characters, not the 80+ of its length;
    // a constant per rule and per call comes on top
    const perRule = 9 + 4;
    expect(meter.steps).toBeLessThanOrEqual(urls * (rules * perRule + 2 * (tail.length + 20 + 64)));
    expect(meter.steps).toBeLessThan(MATCH_STEP_BUDGET);
    expect(matchRobots(compiled, `/s-1-${tail}`, meter).kind).toBe('blocked'); // still not over-limit
  });

  it('answers over-limit once the step budget is spent, and for paths over 8,192 chars', () => {
    const compiled = rulesFor('User-agent: *\nDisallow: /*x');
    const meter = { steps: MATCH_STEP_BUDGET - 10_000 };
    const path = '/' + 'a'.repeat(1000);
    let allowed = 0;
    while (matchRobots(compiled, path, meter).kind === 'allowed') allowed++;
    // a call costs 2,067 steps (the 1,001-char path twice, 64 per call, 1 for the rule the prefilter skips): 4 fit in 10,000, the 5th crosses the budget
    expect(allowed).toBe(4);
    expect(matchRobots(compiled, '/x', meter).kind).toBe('over-limit'); // stays spent
    expect(matchRobots(compiled, '/x', { steps: 0 }).kind).toBe('blocked'); // the compiled set is not spent, only the meter
    expect(kind('User-agent: *\nDisallow: /', '/' + 'a'.repeat(8191))).toBe('blocked'); // 8,192 chars: still checked
    expect(kind('User-agent: *\nDisallow: /', '/' + 'a'.repeat(8192))).toBe('over-limit'); // 8,193 chars
  });

  it('stops inside a call once the budget is spent, overshooting by at most one rule', () => {
    const path = '/' + 'a'.repeat(1000) + '0123456789b';
    const compiled = rulesFor('User-agent: *\n' + Array.from({ length: 1000 }, (_, i) => `Disallow: /*a*b${i}`).join('\n'));
    const meter = { steps: MATCH_STEP_BUDGET - 5000 };
    expect(matchRobots(compiled, path, meter).kind).toBe('over-limit');
    expect(meter.steps).toBeLessThanOrEqual(MATCH_STEP_BUDGET + 64 + 2 * path.length + 2 * path.length + 20);
  });

  it('shares one compiled set between independent meters', () => {
    const compiled = rulesFor('User-agent: *\nDisallow: /*x');
    const a = { steps: 0 };
    const b = { steps: 0 };
    matchRobots(compiled, '/aaaa', a);
    expect(a.steps).toBe(75); // the 5-char path twice, 64 for the call, 1 for the rule the prefilter skips (no x in the path)
    expect(b.steps).toBe(0);
    matchRobots(compiled, '/aaaa', b);
    expect(b.steps).toBe(75);
    expect(a.steps).toBe(75);
  });

  describe('prefilter and compile cap', () => {
    const urls = 50_000;
    const facets = (n: number) => Array.from({ length: n }, (_, i) => `Disallow: /*?*p${i}=`);
    const mixed = (n: number) => ['User-agent: *', 'Allow: /products/keep-', 'Disallow: /checkout', 'Disallow: /*.pdf$', 'Disallow: /*/draft/', ...facets(n)].join('\n');

    it('gives every URL of a faceted-filter robots.txt a verdict within one meter', () => {
      const compiled = rulesFor(mixed(100));
      const meter = { steps: 0 };
      for (let n = 0; n < urls; n++) {
        const path = `/products/item-${n}-blue-cotton-shirt`;
        expect(matchRobots(compiled, path, meter).kind).toBe('allowed');
      }
      expect(meter.steps).toBeLessThan(MATCH_STEP_BUDGET);
      // per URL: the path twice, the call constant, and one step for each of the 104 rules the prefilter skips (a few cost more)
      expect(meter.steps).toBeLessThanOrEqual(urls * (2 * 45 + 64 + 104 + 30));
      expect(matchRobots(compiled, '/checkout/cart', meter).kind).toBe('blocked');
    });

    it('still blocks URLs that carry the query parameter', () => {
      const compiled = rulesFor(mixed(100));
      const meter = { steps: 0 };
      for (let n = 0; n < 5000; n++) { // rules that pass the prefilter cost a full path scan each, so fewer URLs than above
        const i = n % 100;
        const path = `/products/item-${n}-blue-cotton-shirt?color=blue&p${i}=1`;
        const verdict = matchRobots(compiled, path, meter);
        expect(verdict.kind).toBe('blocked');
        if (verdict.kind === 'blocked') expect(verdict.rule.path).toBe(`/*?*p${i}=`);
      }
      expect(meter.steps).toBeLessThan(MATCH_STEP_BUDGET);
      expect(matchRobots(compiled, '/products/item-1?color=blue&q=1', meter).kind).toBe('allowed'); // a query without any facet
      expect(matchRobots(compiled, '/products/keep-1?p3=1', meter)).toEqual({ kind: 'allowed', rule: { allow: true, path: '/products/keep-', line: 2 } });
    });

    it('answers over-limit for every match once a compiled set holds more than 50,000 parts', () => {
      // a rule path is at most 2,048 chars: 1,000 parts each, 50 rules make exactly 50,000
      const rules = Array.from({ length: 50 }, () => `Disallow: /a${'*a'.repeat(999)}`);
      const just = rulesFor(['User-agent: *', ...rules].join('\n'));
      expect(matchRobots(just, '/a'.repeat(1000), { steps: 0 }).kind).toBe('blocked');
      const over = rulesFor(['User-agent: *', ...rules, 'Disallow: /b'].join('\n'));
      expect(matchRobots(over, '/b', { steps: 0 }).kind).toBe('over-limit'); // never blocked
      expect(matchRobots(over, '/robots.txt', { steps: 0 }).kind).toBe('over-limit');
      expect(matchRobots(over, '/zzz', { steps: 0 }).kind).toBe('over-limit');
    });
  });

  it('compiles an agent once per groups array', () => {
    const { groups } = parseRobotsGroups('User-agent: *\nDisallow: /x');
    expect(compileRobots(groups, 'Googlebot')).toBe(compileRobots(groups, 'googlebot/2.1'));
    expect(compileRobots(groups, 'Bingbot')).not.toBe(compileRobots(groups, 'Googlebot'));
  });
});
