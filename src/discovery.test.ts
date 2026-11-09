import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMON_PATHS, discoverSitemaps, pLimit } from './discovery.js';
import { sniffSitemap, type SniffResult } from './fetcher.js';
import { MAX_PAGE_LINKS } from './url.js';

const ok = (url: string, kind: 'urlset' | 'sitemapindex' = 'urlset', extra: Partial<SniffResult> = {}): SniffResult =>
  ({ sniff: kind, status: 200, finalUrl: url, redirected: false, gzip: false, ...extra });
const miss = (): SniffResult => ({ sniff: 'http-error', status: 404 });
const sniffing = (hits: Record<string, SniffResult> = {}) => vi.fn(async (url: string, _opts?: unknown): Promise<SniffResult> => hits[url] ?? miss());

describe('pLimit', () => {
  it('runs at most n at once, starts the next as soon as one finishes, and returns each result', async () => {
    const limit = pLimit(2);
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => { let open!: () => void; const gate = new Promise<void>((r) => { open = r; }); return { gate, open }; });
    const results = gates.map((g, i) => limit(async () => { started.push(i); await g.gate; return i * 10; }));
    await vi.waitFor(() => { expect(started).toEqual([0, 1]); });
    gates[1]!.open();
    await vi.waitFor(() => { expect(started).toEqual([0, 1, 2]); });
    gates[0]!.open(); gates[2]!.open();
    await vi.waitFor(() => { expect(started).toEqual([0, 1, 2, 3, 4]); });
    gates[3]!.open(); gates[4]!.open();
    expect(await Promise.all(results)).toEqual([0, 10, 20, 30, 40]);
  });
  it('keeps limiting after earlier tasks finished: a late task still runs, and no more than n run at once', async () => {
    const limit = pLimit(2);
    expect(await Promise.all([limit(async () => 'a'), limit(async () => 'b'), limit(async () => 'c')])).toEqual(['a', 'b', 'c']);
    expect(await limit(async () => 'late')).toBe('late');
    const started: number[] = [];
    const gates = Array.from({ length: 4 }, () => { let open!: () => void; const gate = new Promise<void>((r) => { open = r; }); return { gate, open }; });
    const results = gates.map((g, i) => limit(async () => { started.push(i); await g.gate; return i; }));
    await vi.waitFor(() => { expect(started).toEqual([0, 1]); });
    gates[0]!.open();
    await vi.waitFor(() => { expect(started).toEqual([0, 1, 2]); });
    gates[1]!.open(); gates[2]!.open();
    await vi.waitFor(() => { expect(started).toEqual([0, 1, 2, 3]); });
    gates[3]!.open();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
  });
  it('hands a rejection to its caller and frees the slot', async () => {
    const limit = pLimit(1);
    const failing = limit(async () => { throw new Error('boom'); });
    const next = limit(async () => 'after');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('after');
  });
});

describe('discoverSitemaps stored fields', () => {
  it('keeps the probed url instead of a redirect target longer than 2,048 characters, and drops a Last-Modified over 64 characters', async () => {
    const long = `https://a.com/${'x'.repeat(2040)}.xml`;
    const sniff = sniffing({
      'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml', 'urlset', { finalUrl: long, redirected: true, lastModified: 'x'.repeat(65) }),
      'https://a.com/sitemap_index.xml': ok('https://a.com/sitemap_index.xml', 'sitemapindex', { lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    });
    const { found } = await discoverSitemaps('https://a.com', null, { sniff });
    const by = (u: string) => found.find((f) => f.url === u)!;
    expect(by('https://a.com/sitemap.xml')).toMatchObject({ finalUrl: 'https://a.com/sitemap.xml', httpLastModified: undefined });
    expect(by('https://a.com/sitemap_index.xml').httpLastModified).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });
  it('keeps a redirect target of exactly 2,048 characters and a Last-Modified of exactly 64, and drops one more of either', async () => {
    const finalOf = (length: number) => `https://a.com/${'x'.repeat(length - 'https://a.com/'.length - '.xml'.length)}.xml`;
    const sniff = sniffing({
      'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml', 'urlset', { finalUrl: finalOf(2048), redirected: true, lastModified: 'x'.repeat(64) }),
      'https://a.com/sitemap_index.xml': ok('https://a.com/sitemap_index.xml', 'urlset', { finalUrl: finalOf(2049), redirected: true, lastModified: 'x'.repeat(65) }),
    });
    const { found } = await discoverSitemaps('https://a.com', null, { sniff });
    const by = (u: string) => found.find((f) => f.url === u)!;
    expect(finalOf(2048)).toHaveLength(2048);
    expect(by('https://a.com/sitemap.xml')).toMatchObject({ finalUrl: finalOf(2048), httpLastModified: 'x'.repeat(64) });
    expect(by('https://a.com/sitemap.xml')).not.toHaveProperty('longFinalOrigin');
    expect(by('https://a.com/sitemap_index.xml')).toMatchObject({ finalUrl: 'https://a.com/sitemap_index.xml', httpLastModified: undefined, longFinalOrigin: 'https://a.com' });
  });
  it('hands over an http origin of a long redirect target, and none for another scheme or an unparsable target', async () => {
    const sniff = sniffing({
      'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml', 'urlset', { finalUrl: `http://b.com:8080/${'x'.repeat(2100)}.xml`, redirected: true }),
      'https://a.com/sitemap_index.xml': ok('https://a.com/sitemap_index.xml', 'urlset', { finalUrl: `ftp://c.com/${'x'.repeat(2100)}.xml`, redirected: true }),
      'https://a.com/sitemap-index.xml': ok('https://a.com/sitemap-index.xml', 'urlset', { finalUrl: 'x'.repeat(2100), redirected: true }),
    });
    const { found } = await discoverSitemaps('https://a.com', null, { sniff });
    const by = (u: string) => found.find((f) => f.url === u)!;
    expect(by('https://a.com/sitemap.xml')).toMatchObject({ finalUrl: 'https://a.com/sitemap.xml', longFinalOrigin: 'http://b.com:8080' });
    for (const u of ['https://a.com/sitemap_index.xml', 'https://a.com/sitemap-index.xml']) {
      expect(by(u), u).toMatchObject({ finalUrl: u });
      expect(by(u), u).not.toHaveProperty('longFinalOrigin');
    }
  });
  it('hands over the origin of a redirect target longer than 2,048 characters, so another host still reads as cross-origin', async () => {
    const sniff = sniffing({
      'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml', 'urlset', { finalUrl: `https://b.com/${'x'.repeat(2100)}.xml`, redirected: true }),
      'https://a.com/sitemap_index.xml': ok('https://a.com/sitemap_index.xml', 'sitemapindex', { finalUrl: 'https://c.com/i.xml', redirected: true }),
    });
    const { found } = await discoverSitemaps('https://a.com', null, { sniff });
    const by = (u: string) => found.find((f) => f.url === u)!;
    expect(by('https://a.com/sitemap.xml')).toMatchObject({ finalUrl: 'https://a.com/sitemap.xml', longFinalOrigin: 'https://b.com' });
    expect(by('https://a.com/sitemap_index.xml')).not.toHaveProperty('longFinalOrigin');
  });
});

describe('COMMON_PATHS', () => {
  it('probes 24 distinct paths, most common first', () => {
    expect(COMMON_PATHS).toHaveLength(24);
    expect(new Set(COMMON_PATHS).size).toBe(24);
    expect(COMMON_PATHS.slice(0, 3)).toEqual(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']);
    for (const p of ['/sitemaps.xml', '/sitemap-0.xml', '/pub/sitemap.xml', '/xmlsitemap.php', '/1_index_sitemap.xml', '/hc/sitemap.xml', '/?type=1533906435', '/sitemap-pages.xml']) {
      expect(COMMON_PATHS).toContain(p);
    }
  });
});

describe('discoverSitemaps', () => {
  const origin = 'https://a.com';

  it('starts no sniff once its signal is aborted, and hands the signal to the ones it starts', async () => {
    const ctrl = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const sniff = vi.fn(async (url: string, opts?: { signal?: AbortSignal | undefined }): Promise<SniffResult> => {
      signals.push(opts?.signal);
      if (signals.length === 3) ctrl.abort();
      await Promise.resolve();
      return url === 'https://a.com/sitemap.xml' ? ok(url) : miss();
    });
    const { found } = await discoverSitemaps(origin, null, { sniff }, { signal: ctrl.signal });
    // the first six candidates start together; the third call aborts, so the fourth to sixth see it before they start, and the queue never runs
    expect(sniff.mock.calls.map(([url]) => url)).toEqual(COMMON_PATHS.slice(0, 3).map((p) => origin + p));
    expect(signals).toEqual([ctrl.signal, ctrl.signal, ctrl.signal]);
    expect(found.map((d) => d.url)).toEqual(['https://a.com/sitemap.xml']); // what the running sniffs returned is still reported
  });
  it('sniffs nothing when the signal is aborted before it starts', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const sniff = sniffing();
    const { found, failedRobots } = await discoverSitemaps(origin, null, { sniff }, { signal: ctrl.signal });
    expect(sniff).not.toHaveBeenCalled();
    expect(found).toEqual([]);
    expect(failedRobots).toEqual([]);
  });

  it('combines robots urls and probed paths, dropping 404s and soft-404s', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> => {
      if (url === 'https://a.com/from-robots.xml') return ok(url, 'sitemapindex');
      if (url === 'https://a.com/sitemap.xml') return ok(url);
      if (url === 'https://a.com/wp-sitemap.xml') return { ...ok(url), sniff: 'not-sitemap' }; // soft 404
      return miss();
    });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/from-robots.xml'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff });
    expect(found.map((d) => [d.url, d.source, d.kind])).toEqual([
      ['https://a.com/from-robots.xml', 'robots', 'sitemapindex'],
      ['https://a.com/sitemap.xml', 'probe', 'urlset'],
    ]);
    expect(failedRobots).toEqual([]);
    expect(sniff).toHaveBeenCalledTimes(1 + COMMON_PATHS.length);
  });

  it('carries the size a sniff found onto the entry, flagged when it is the compressed one, and none when the sniff had none', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> => {
      if (url === 'https://a.com/sitemap.xml') return ok(url, 'urlset', { size: 52_428_800 });
      if (url === 'https://a.com/sitemap.xml.gz') return ok(url, 'urlset', { size: 4096, sizeCompressed: true, gzip: true });
      if (url === 'https://a.com/sitemap_index.xml') return ok(url, 'sitemapindex', { size: null });
      if (url === 'https://a.com/sitemap-index.xml') return ok(url, 'sitemapindex');
      return miss();
    });
    const { found } = await discoverSitemaps(origin, null, { sniff });
    expect(found.map((d) => [d.url, d.size, d.sizeCompressed])).toEqual([
      ['https://a.com/sitemap.xml', 52_428_800, undefined],
      ['https://a.com/sitemap_index.xml', null, undefined],
      ['https://a.com/sitemap-index.xml', undefined, undefined],
      ['https://a.com/sitemap.xml.gz', 4096, true],
    ]);
    expect('size' in found[2]!).toBe(false);
  });

  it('dedupes by final url across redirects, robots wins', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> => {
      if (url === 'https://a.com/canonical.xml') return ok('https://a.com/real.xml', 'urlset', { redirected: true });
      if (url === 'https://a.com/sitemap.xml') return ok('https://a.com/real.xml', 'urlset', { redirected: true });
      return miss();
    });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/canonical.xml'] };
    const { found } = await discoverSitemaps(origin, robots, { sniff });
    expect(found.map((d) => [d.url, d.finalUrl, d.source, d.redirected])).toEqual([['https://a.com/canonical.xml', 'https://a.com/real.xml', 'robots', true]]);
  });

  it('reports robots urls that fail as failedRobots', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> =>
      url === 'https://a.com/broken.xml' ? ({ sniff: 'not-sitemap', status: 200, finalUrl: url }) : miss());
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/broken.xml'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff });
    expect(found).toEqual([]);
    expect(failedRobots).toEqual([{ url: 'https://a.com/broken.xml', reason: 'not-sitemap', status: 200 }]);
  });

  it('finds a probe-path sitemap when there is no robots.txt', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> => (url === `${origin}/sitemap.xml` ? ok(url) : miss()));
    const { found, failedRobots } = await discoverSitemaps(origin, null, { sniff });
    expect(found.map((d) => [d.url, d.source])).toEqual([[`${origin}/sitemap.xml`, 'probe']]);
    expect(failedRobots).toEqual([]);
  });

  it('isolates a throwing sniff: it counts as a failed robots url and the rest still resolve', async () => {
    const sniff = vi.fn(async (url: string): Promise<SniffResult> => {
      if (url === 'https://a.com/boom.xml') throw new Error('internal failure');
      return url === `${origin}/sitemap.xml` ? ok(url) : miss();
    });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/boom.xml'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff });
    expect(found.map((d) => d.url)).toEqual([`${origin}/sitemap.xml`]);
    expect(failedRobots).toEqual([{ url: 'https://a.com/boom.xml', reason: 'network-error' }]);
  });

  describe('the deadline', () => {
    // Every sniff advances the clock by 10; the six slots start together, so each checks the clock after the sniffs before it.
    const run = async (deadline: number) => {
      let clock = 0;
      const sniff = vi.fn(async (url: string): Promise<SniffResult> => { clock += 10; return ok(url); });
      const sitemapUrls = Array.from({ length: 50 }, (_, i) => `https://a.com/s${i}.xml`);
      const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls };
      const result = await discoverSitemaps(origin, robots, { sniff }, { deadline, now: () => clock });
      return { sniff, sitemapUrls, ...result };
    };
    it('keeps sniffing at the deadline itself, in order, and reports the rest of the robots urls as time-limit', async () => {
      const { sniff, sitemapUrls, found, failedRobots } = await run(20); // clock reads 0, 10, 20: none is past 20; the fourth reads 30
      expect(sniff.mock.calls.map(([url]) => url)).toEqual(sitemapUrls.slice(0, 3));
      expect(found.map((d) => d.url)).toEqual(sitemapUrls.slice(0, 3));
      expect(failedRobots).toEqual(sitemapUrls.slice(3).map((url) => ({ url, reason: 'time-limit' })));
    });
    it('stops one sniff earlier when the deadline is one tick sooner', async () => {
      const { sniff, sitemapUrls, found, failedRobots } = await run(19);
      expect(sniff.mock.calls.map(([url]) => url)).toEqual(sitemapUrls.slice(0, 2));
      expect(found.map((d) => d.url)).toEqual(sitemapUrls.slice(0, 2));
      expect(failedRobots.map((f) => f.url)).toEqual(sitemapUrls.slice(2));
      expect(failedRobots.every((f) => f.reason === 'time-limit')).toBe(true);
    });
  });

  it('passes every sniff the same options object, empty when there is no signal and no transport', async () => {
    const sniff = sniffing({});
    await discoverSitemaps(origin, null, { sniff });
    expect(sniff.mock.calls.map(([, opts]) => opts)).toEqual(Array.from({ length: COMMON_PATHS.length }, () => ({})));
  });

  it('sniffs the tab url first and lists it with source tab, without its fragment', async () => {
    const sniff = sniffing({ 'https://a.com/feeds/map.xml': ok('https://a.com/feeds/map.xml') });
    const { found } = await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/feeds/map.xml#top' });
    expect(sniff.mock.calls[0]![0]).toBe('https://a.com/feeds/map.xml');
    expect(found.map((d) => [d.url, d.source])).toEqual([['https://a.com/feeds/map.xml', 'tab']]);
    expect(sniff).toHaveBeenCalledTimes(1 + COMMON_PATHS.length);
  });

  it('sniffs a sitemap-named tab url without an xml extension', async () => {
    const sniff = sniffing({ 'https://a.com/index.php?sitemap=1': ok('https://a.com/index.php?sitemap=1') });
    const { found } = await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/index.php?sitemap=1' });
    expect(found.map((d) => [d.url, d.source])).toEqual([['https://a.com/index.php?sitemap=1', 'tab']]);
  });

  it('never fetches an ordinary html tab or a single-use link', async () => {
    const sniff = sniffing();
    const { found, failedRobots } = await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/blog/post' });
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/account/reset?token=abc' });
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/' });
    expect(found).toEqual([]);
    expect(failedRobots).toEqual([]);
    expect(sniff).toHaveBeenCalledTimes(3 * COMMON_PATHS.length);
    const called = sniff.mock.calls.map(([u]) => u);
    expect(called).not.toContain('https://a.com/blog/post');
    expect(called.some((u) => u.includes('token='))).toBe(false);
  });

  it('never fetches a token url that carries a sitemap-looking parameter next to the token', async () => {
    const sniff = sniffing();
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/account/reset?token=abc&next=sitemap.xml' });
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/reset;sitemap?token=abc' });
    expect(sniff.mock.calls.map(([u]) => u).some((u) => u.includes('token='))).toBe(false);
  });

  it('strips userinfo from the tab url and page links before sniffing', async () => {
    const sniff = sniffing();
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://u:p@a.com/map.xml', pageLinks: ['https://x:y@a.com/page.xml'] });
    const called = sniff.mock.calls.map(([u]) => u);
    expect(called.slice(0, 2)).toEqual(['https://a.com/map.xml', 'https://a.com/page.xml']); // the tab first, then the page link
    expect(called).toHaveLength(2 + COMMON_PATHS.length);
    expect(called.some((u) => u.includes('@'))).toBe(false);
  });

  it('sniffs a tab url that robots.txt also lists once, and still reports its failure', async () => {
    const sniff = sniffing();
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/listed.xml'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff }, { tabUrl: 'https://a.com/listed.xml' });
    expect(sniff.mock.calls.filter(([u]) => u === 'https://a.com/listed.xml')).toHaveLength(1);
    expect(found).toEqual([]);
    expect(failedRobots).toEqual([{ url: 'https://a.com/listed.xml', reason: 'http-error', status: 404 }]);
  });

  it('lists a tab url that is also a probe path once, as the tab', async () => {
    const sniff = sniffing({ 'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml') });
    const { found } = await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://a.com/sitemap.xml' });
    expect(found.map((d) => [d.url, d.source])).toEqual([['https://a.com/sitemap.xml', 'tab']]);
    expect(sniff).toHaveBeenCalledTimes(COMMON_PATHS.length);
  });

  it('ignores a tab url on another origin or with another scheme', async () => {
    const sniff = sniffing();
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'https://b.com/sitemap.xml' });
    await discoverSitemaps(origin, null, { sniff }, { tabUrl: 'javascript:alert(1)' });
    expect(sniff).toHaveBeenCalledTimes(2 * COMMON_PATHS.length);
    expect(sniff.mock.calls.map(([u]) => u)).not.toContain('https://b.com/sitemap.xml');
  });

  it('adds page links after robots, capped at 20, http(s) only, deduped against probes, failures silent', async () => {
    const links = [
      'https://a.com/sitemap.xml',
      'javascript:alert(1)', 'mailto:a@a.com', 'not a url',
      ...Array.from({ length: 25 }, (_, i) => `https://a.com/page-${i}.xml#x`),
    ];
    const sniff = sniffing({ 'https://a.com/page-0.xml': ok('https://a.com/page-0.xml', 'sitemapindex') });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/r.xml'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff }, { pageLinks: links });
    const called = sniff.mock.calls.map(([u]) => u);
    expect(called.indexOf('https://a.com/r.xml')).toBeLessThan(called.indexOf('https://a.com/page-0.xml'));
    // the cap counts http(s) links only (sitemap.xml plus MAX_PAGE_LINKS - 1 page-N, fragments cut); the javascript:, mailto: and unparsable links take no slot
    expect(called.filter((u) => u.includes('/page-'))).toEqual(Array.from({ length: MAX_PAGE_LINKS - 1 }, (_, i) => `https://a.com/page-${i}.xml`));
    expect(called.filter((u) => u === 'https://a.com/sitemap.xml')).toHaveLength(1);
    expect(called).toHaveLength(1 + MAX_PAGE_LINKS + COMMON_PATHS.length - 1); // robots, the capped links, the probe paths without the one a link already named
    expect(called.some((u) => !u.startsWith('https://'))).toBe(false);
    expect(found.map((d) => [d.url, d.source, d.kind])).toEqual([['https://a.com/page-0.xml', 'page', 'sitemapindex']]);
    expect(failedRobots).toEqual([{ url: 'https://a.com/r.xml', reason: 'http-error', status: 404 }]);
  });
  it('fills in the defaults of a bare sniff result: probed url as final url, no gzip, status 200, no redirect', async () => {
    const sniff = sniffing({ 'https://a.com/sitemap.xml': { sniff: 'sitemapindex' } });
    const { found } = await discoverSitemaps(origin, null, { sniff });
    expect(found).toStrictEqual([{
      url: 'https://a.com/sitemap.xml', finalUrl: 'https://a.com/sitemap.xml', source: 'probe', kind: 'sitemapindex', gzip: false, httpStatus: 200, redirected: false,
      httpLastModified: undefined, contentType: undefined,
    }]);
  });

  it('ignores a tab url that does not parse', async () => {
    const sniff = sniffing();
    await expect(discoverSitemaps(origin, null, { sniff }, { tabUrl: 'not a url' })).resolves.toEqual({ found: [], failedRobots: [] });
    expect(sniff).toHaveBeenCalledTimes(COMMON_PATHS.length);
  });

  it('maps a sniff result onto the found sitemap: final url, gzip, status, redirect, last-modified and normalized content type', async () => {
    const sniff = sniffing({ 'https://a.com/sitemap.xml': ok('https://a.com/sitemap.xml', 'urlset', {
      finalUrl: 'https://a.com/moved.xml', gzip: true, status: 203, redirected: true, lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT', contentType: 'Text/HTML; charset=UTF-8',
    }) });
    const { found } = await discoverSitemaps(origin, null, { sniff });
    expect(found).toEqual([{
      url: 'https://a.com/sitemap.xml', finalUrl: 'https://a.com/moved.xml', source: 'probe', kind: 'urlset', gzip: true, httpStatus: 203, redirected: true,
      httpLastModified: 'Wed, 01 Jul 2026 00:00:00 GMT', contentType: 'text/html',
    }]);
  });
});

describe('discoverSitemaps with plain-text sitemaps', () => {
  afterEach(() => vi.unstubAllGlobals());
  const origin = 'https://a.com';
  const TEXT = 'https://a.com/1\nhttps://a.com/2\n';
  // The real sniff over a stubbed network: only the listed urls exist, everything else is a 404.
  const network = (bodies: Record<string, [string, string]>) => vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = input;
    const hit = bodies[url];
    const res = new Response(hit ? hit[0] : 'nope', { status: hit ? 200 : 404, headers: { 'content-type': hit ? hit[1] : 'text/plain' } });
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    return res;
  }));

  it('finds a text sitemap listed in robots.txt as a urlset', async () => {
    network({ 'https://a.com/list.txt': [TEXT, 'text/plain'] });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/list.txt'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff: sniffSitemap });
    expect(found.map((d) => [d.url, d.source, d.kind, d.contentType])).toEqual([['https://a.com/list.txt', 'robots', 'urlset', 'text/plain']]);
    expect(failedRobots).toEqual([]);
  });

  it('finds a text sitemap on a probe path whatever its content type', async () => {
    network({ 'https://a.com/sitemap.xml': [TEXT, 'application/octet-stream'] });
    const { found } = await discoverSitemaps(origin, null, { sniff: sniffSitemap });
    expect(found.map((d) => [d.url, d.source, d.kind])).toEqual([['https://a.com/sitemap.xml', 'probe', 'urlset']]);
  });

  it('finds a text sitemap through the tab url', async () => {
    network({ 'https://a.com/feeds/sitemap-urls.txt': [TEXT, 'text/plain'] });
    const hit = await discoverSitemaps(origin, null, { sniff: sniffSitemap }, { tabUrl: 'https://a.com/feeds/sitemap-urls.txt' });
    expect(hit.found.map((d) => [d.url, d.source, d.kind])).toEqual([['https://a.com/feeds/sitemap-urls.txt', 'tab', 'urlset']]);
  });

  it('still rejects a plain-text not-found and a JSON body, listing a robots one as not-sitemap', async () => {
    network({
      'https://a.com/sitemap.xml': ['Not found', 'text/plain'],
      'https://a.com/sitemap_index.xml': ['{"error":"https://a.com/x"}', 'application/json'],
      'https://a.com/gone.txt': ['Not found', 'text/plain'],
    });
    const robots = { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/gone.txt'] };
    const { found, failedRobots } = await discoverSitemaps(origin, robots, { sniff: sniffSitemap });
    expect(found).toEqual([]);
    expect(failedRobots).toEqual([{ url: 'https://a.com/gone.txt', reason: 'not-sitemap', status: 200 }]);
  });
});
