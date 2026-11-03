import { describe, expect, it } from 'vitest';
import { ValidationRun, type ValidationContext } from './validator.js';
import { EXAMPLE_MAX } from './extensions.js';
import { MATCH_STEP_BUDGET, parseRobotsGroups } from './robots.js';
import { MAX_SITEMAP_BYTES, MAX_SITEMAP_URLS } from './sitemap-limits.js';
import { rowFlag } from './row-flags.js';
import { SitemapParser } from './parser.js';
import { parsedLoc } from './normalize.js';
import type { ParseResult } from './parser.js';
import type { RobotsInfo, SitemapStats, UrlRecord } from './types.js';

export const baseCtx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  origin: 'https://a.com', sitemapUrl: 'https://a.com/sitemap.xml', finalUrl: 'https://a.com/sitemap.xml',
  redirected: false, robots: { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/sitemap.xml'] },
  now: Date.parse('2026-08-27T00:00:00Z'), ...over,
});
export const emptyParse = (over: Partial<ParseResult> = {}): ParseResult => ({
  kind: 'urlset', children: [], issues: [], bareAmpersands: 0, truncated: false,
  stats: { urlCount: 1, byteSize: 100, topLastmodShare: 0, duplicateCount: 0, languages: [], clusterCount: 0, hasPriority: false, hasChangefreq: false, imageCount: 0 },
  ...over,
});
const rec = (loc: string, over: Partial<UrlRecord> = {}): UrlRecord => ({ loc, line: 1, ...over });
export function run(records: UrlRecord[], parse = emptyParse(), ctx = baseCtx()) {
  const v = new ValidationRun(ctx);
  v.recordBatch(records);
  return v.finish(parse);
}
const ids = (f: { ruleId: string; severity: string }[], sev?: string) => f.filter((x) => !sev || x.severity === sev).map((x) => x.ruleId);

describe('error rules', () => {
  it('maps structural issues to findings', () => {
    const f = run([], emptyParse({ issues: [
      { code: 'xml-error', message: 'bad', line: 5, detail: 'unterminated-markup', params: {} },
      { code: 'namespace', message: 'wrong ns', line: 2, detail: 'wrong-namespace', params: { attr: 'xmlns', value: '', expected: 'x' } },
      { code: 'loc-missing', message: 'no loc', line: 7, detail: 'url-without-loc', params: {} },
    ] }));
    expect(ids(f)).toEqual(['xml-parse-error', 'missing-namespace', 'missing-loc']);
    expect(ids(f, 'error')).toHaveLength(3);
    expect(f.find((x) => x.ruleId === 'xml-parse-error')!.examples).toEqual([{ value: 'bad', line: 5, code: 'unterminated-markup', params: {} }]);
    expect(f.find((x) => x.ruleId === 'missing-loc')!.examples).toEqual([{ value: 'no loc', line: 7, code: 'url-without-loc', params: {} }]);
  });
  it('carries the issue code and params onto the example, capping string params like values', () => {
    const f = run([], emptyParse({ issues: [{
      code: 'namespace', message: 'wrong ns', line: 2, detail: 'wrong-namespace',
      params: { attr: 'xmlns', value: 'v'.repeat(10_000), expected: 'http://www.sitemaps.org/schemas/sitemap/0.9' },
    }] }));
    const ex = f.find((x) => x.ruleId === 'missing-namespace')!.examples[0]!;
    expect(ex).toEqual({
      value: 'wrong ns', line: 2, code: 'wrong-namespace',
      params: { attr: 'xmlns', value: 'v'.repeat(EXAMPLE_MAX) + '…', expected: 'http://www.sitemaps.org/schemas/sitemap/0.9' },
    });
  });
  it('codes its own prose examples', () => {
    const stats = { ...emptyParse().stats, urlCount: 20, byteSize: 60_000_000, topLastmodShare: 0.95 };
    const f = run([], emptyParse({ truncated: true, stats }));
    expect(f.find((x) => x.ruleId === 'parse-truncated')!.examples).toEqual([{ value: 'stopped after 20 entries', code: 'stopped-after', params: { count: 20 } }]);
    expect(f.find((x) => x.ruleId === 'file-too-large')!.examples).toEqual([{ value: '57.3 MB', code: 'size-mb', params: { size: 57.3 } }]);
    expect(f.find((x) => x.ruleId === 'fake-freshness')!.examples).toEqual([{ value: '95% identical', code: 'identical-share', params: { percent: 95 } }]);
  });
  it('flags invalid, oversized and non-utf8 locs', () => {
    const f = run([rec('relative/x'), rec('ftp://a.com/x'), rec('https://a.com/' + 'y'.repeat(2050)), rec('https://a.com/bad�path')]);
    expect(f.map((x) => [x.ruleId, x.severity, x.count])).toEqual([['invalid-loc', 'error', 2], ['loc-too-long', 'error', 1], ['invalid-utf8', 'error', 1]]);
    expect(f.find((x) => x.ruleId === 'invalid-loc')!.examples).toEqual([{ value: 'relative/x', line: 1 }, { value: 'ftp://a.com/x', line: 1 }]);
    expect(f.find((x) => x.ruleId === 'invalid-utf8')!.examples).toEqual([{ value: 'https://a.com/bad�path', line: 1 }]);
  });
  it('enforces the spec limits of 50,000 URLs and 50 MiB, flagging one past each and nothing at them', () => {
    const limits = (urlCount: number, byteSize: number) => run([], emptyParse({ stats: { ...emptyParse().stats, urlCount, byteSize } }));
    expect(limits(MAX_SITEMAP_URLS, MAX_SITEMAP_BYTES)).toEqual([]);
    const f = limits(MAX_SITEMAP_URLS + 1, MAX_SITEMAP_BYTES + 1);
    expect(f.map((x) => [x.ruleId, x.severity, x.count])).toEqual([['too-many-urls', 'error', 1], ['file-too-large', 'error', 1]]);
    expect(f[0]!.examples).toEqual([{ value: '50001' }]);
    expect(f[1]!.examples[0]).toMatchObject({ code: 'size-mb' });
    expect(limits(MAX_SITEMAP_URLS + 1, MAX_SITEMAP_BYTES).map((x) => x.ruleId)).toEqual(['too-many-urls']);
    expect(limits(MAX_SITEMAP_URLS, MAX_SITEMAP_BYTES + 1).map((x) => x.ruleId)).toEqual(['file-too-large']);
    expect(limits(MAX_SITEMAP_URLS, MAX_SITEMAP_BYTES + 1)[0]!.examples).toEqual([{ value: '50.1 MB', code: 'size-mb', params: { size: 50.1 } }]); // never "50 MB" for a file over 50 MB
    expect(limits(MAX_SITEMAP_URLS, 60 * 1_048_576)[0]!.examples).toEqual([{ value: '60 MB', code: 'size-mb', params: { size: 60 } }]);
    expect(limits(MAX_SITEMAP_URLS + 1, 60_000_000)[1]!.examples).toEqual([{ value: '57.3 MB', code: 'size-mb', params: { size: 57.3 } }]);
  });
  it('flags every URL whose scheme, host (www included) or port differs from the sitemap as cross-host', () => {
    const f = run([
      rec('https://other.example/x'), rec('https://www.a.com/y'), rec('http://a.com/z'), rec('https://a.com:8443/p'),
      rec('https://A.com/ok'), rec('https://a.com:443/ok2'), rec('https://a.com/ok3'),
    ]);
    const cross = f.find((x) => x.ruleId === 'cross-host')!;
    expect(cross).toMatchObject({ severity: 'error', count: 4 });
    expect(cross.examples.map((e) => e.value)).toEqual(['https://other.example/x', 'https://www.a.com/y', 'http://a.com/z', 'https://a.com:8443/p']);
    expect(f.map((x) => x.ruleId)).toEqual(['cross-host']); // not protocol-www-mix as well
  });
  it('sets the cross-host bit on those rows only', () => {
    const records = [rec('https://a.com/ok'), rec('http://a.com/z')];
    run(records);
    expect(records.map((r) => r.flags)).toEqual([undefined, rowFlag('cross-host')]);
  });
  it('validates lastmod, changefreq, priority values', () => {
    const f = run([
      rec('https://a.com/1', { lastmod: '01.05.2026' }),
      rec('https://a.com/2', { changefreq: 'sometimes' }),
      rec('https://a.com/3', { priority: '7' }),
      rec('https://a.com/4', { lastmod: '2026-05-01', changefreq: 'daily', priority: '0.5' }),
    ]);
    expect(f.map((x) => [x.ruleId, x.severity, x.count, x.examples])).toEqual([
      ['invalid-lastmod', 'error', 1, [{ value: '01.05.2026', line: 1 }]],
      ['invalid-changefreq', 'error', 1, [{ value: 'sometimes', line: 1 }]],
      ['invalid-priority', 'error', 1, [{ value: '7', line: 1 }]],
    ]);
  });
  it('does not backtrack on a huge digit priority', () => {
    const t0 = performance.now();
    const f = run([rec('https://a.com/1', { priority: '1'.repeat(320_000) + 'x' }), rec('https://a.com/2', { priority: '0.5' }), rec('https://a.com/3', { priority: '1.' }), rec('https://a.com/4', { priority: '.5' })]);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(f.find((x) => x.ruleId === 'invalid-priority')!.count).toBe(1);
  });
  it('accepts any xsd:decimal from 0 to 1 as a priority', () => {
    const good = ['1.', '+0.5', '-0', '.5', '0', '1', '1.0', '0.000000000000000000001', '1.000000000000000000000', '+.25', '-0.0', '0.' + '0'.repeat(62)]; // the last one is 64 characters
    const bad = ['1.1', '-0.1', '+1.5', '', '.', '+', '1e0', '0x1', '0.5.5', ' 0.5', '1,0', '0.' + '0'.repeat(63), '0.' + '0'.repeat(70)]; // 65 characters is one too many
    expect(run(good.map((p, i) => rec(`https://a.com/g${i}`, { priority: p })))).toEqual([]);
    const f = run(bad.map((p, i) => rec(`https://a.com/b${i}`, { priority: p })));
    expect(f.find((x) => x.ruleId === 'invalid-priority')).toMatchObject({ count: bad.length });
  });
  it('fails a loc of 2,048 characters but not one of 2,047', () => {
    const at = (n: number) => 'https://a.com/' + 'x'.repeat(n - 'https://a.com/'.length);
    expect(run([rec(at(2047))])).toEqual([]);
    expect(run([rec(at(2048))]).find((f) => f.ruleId === 'loc-too-long')).toMatchObject({ severity: 'error', count: 1 });
  });
  it('keeps an example value of EXAMPLE_MAX chars whole and cuts a longer one to EXAMPLE_MAX plus an ellipsis', () => {
    const valueFor = (n: number) => run([rec('relative/' + 'x'.repeat(n - 'relative/'.length))]).find((x) => x.ruleId === 'invalid-loc')!.examples[0]!.value;
    expect(valueFor(EXAMPLE_MAX)).toBe('relative/' + 'x'.repeat(EXAMPLE_MAX - 'relative/'.length));
    expect(valueFor(EXAMPLE_MAX + 1)).toBe('relative/' + 'x'.repeat(EXAMPLE_MAX - 'relative/'.length) + '…');
    expect(valueFor(100_000)).toBe('relative/' + 'x'.repeat(EXAMPLE_MAX - 'relative/'.length) + '…');
  });
  it('validates lastmod on index children', () => {
    const parse = emptyParse({ kind: 'sitemapindex', children: [
      { loc: 'https://a.com/a.xml', lastmod: '2026-02-30', line: 3 },
      { loc: 'https://a.com/b.xml', lastmod: '2027-01-01', line: 4 },
      { loc: 'https://a.com/c.xml', lastmod: '2026-05', line: 5 },
    ] });
    const f = run([], parse);
    expect(f.find((x) => x.ruleId === 'invalid-lastmod')!.count).toBe(1);
    expect(f.find((x) => x.ruleId === 'future-lastmod')!.count).toBe(1);
  });
  it('calls a lastmod future only when it is more than a day past the scan clock', () => {
    const future = (lastmod: string) => run([rec('https://a.com/1', { lastmod })]).map((x) => x.ruleId);
    expect(future('2026-08-28T00:00:00Z')).toEqual([]); // exactly now + 1 day
    expect(future('2026-08-28T00:00:01Z')).toEqual(['future-lastmod']);
    expect(future('2026-08-27')).toEqual([]);
    expect(future('2026-08-29')).toEqual(['future-lastmod']);
  });
  it('treats YYYY and YYYY-MM lastmod as valid and still detects the future', () => {
    const f = run([rec('https://a.com/1', { lastmod: '2026' }), rec('https://a.com/2', { lastmod: '2026-05' }), rec('https://a.com/3', { lastmod: '2031-01' })]);
    expect(f.map((x) => [x.ruleId, x.count, x.examples])).toEqual([['future-lastmod', 1, [{ value: '2031-01', line: 1 }]]]);
  });
  it('validates index children and aggregates examples to 5', () => {
    const parse = emptyParse({ kind: 'sitemapindex', children: Array.from({ length: 8 }, (_, i) => ({ loc: `bad-${i}`, line: i + 2 })) });
    const f = run([], parse);
    const finding = f.find((x) => x.ruleId === 'invalid-child-loc')!;
    expect(finding.count).toBe(8);
    expect(finding.examples).toEqual([0, 1, 2, 3, 4].map((i) => ({ value: `bad-${i}`, line: i + 2 })));
  });
  it('reports a child loc with a wildcard host (also %2A and fullwidth) as invalid, which the scan does not follow', () => {
    const locs = ['https://*.x.com/s.xml', 'https://%2A.x.com/s.xml', 'https://＊.x.com/s.xml', 'https://x.com/ok.xml'];
    const parse = emptyParse({ kind: 'sitemapindex', children: locs.map((loc, i) => ({ loc, line: i + 2 })) });
    const finding = run([], parse).find((x) => x.ruleId === 'invalid-child-loc')!;
    expect(finding.count).toBe(3);
    expect(finding.examples.map((e) => e.value)).toEqual(locs.slice(0, 3));
  });
  it('flags truncated parses as an error', () => {
    const f = run([], emptyParse({ truncated: true }));
    expect(f.map((x) => [x.ruleId, x.severity, x.count])).toEqual([['parse-truncated', 'error', 1]]);
    expect(ids(run([]))).toEqual([]);
  });

  it('flags unescaped ampersands from the parser bareAmpersands count', () => {
    const f = run([], emptyParse({ bareAmpersands: 3 }));
    expect(f).toEqual([{
      ruleId: 'unescaped-ampersand', severity: 'error', message: 'Unescaped & characters (write them as &amp;)', count: 3, examples: [{ value: '&' }],
    }]);
    expect(run([], emptyParse({ bareAmpersands: 0 }))).toEqual([]);
  });
});

describe('warning and info rules', () => {
  it('warns when sitemap is missing from robots.txt', () => {
    const ctx = baseCtx({ robots: { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/other.xml'] } });
    expect(run([rec('https://a.com/x')], emptyParse(), ctx)).toEqual([{
      ruleId: 'not-in-robots', severity: 'warning', message: 'Sitemap is not referenced in robots.txt', count: 1, examples: [{ value: 'https://a.com/sitemap.xml' }],
    }]);
  });
  it('does not warn without robots.txt, with an unfound one, or when listed', () => {
    const notInRobots = (ctx: ValidationContext) => run([rec('https://a.com/x')], emptyParse(), ctx).filter((f) => f.ruleId === 'not-in-robots');
    expect(notInRobots(baseCtx({ robots: null }))).toEqual([]);
    expect(notInRobots(baseCtx({ robots: { found: false, url: 'https://a.com/robots.txt', sitemapUrls: [] } }))).toEqual([]);
    expect(notInRobots(baseCtx())).toEqual([]);
    expect(run([rec('https://a.com/x')], emptyParse(), baseCtx())).toEqual([]);
  });
  it('does not warn for a sitemap reached through a parent index', () => {
    const ctx = baseCtx({
      sitemapUrl: 'https://a.com/child.xml', finalUrl: 'https://a.com/child.xml', viaIndex: true,
      robots: { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/index.xml'] },
    });
    expect(run([rec('https://a.com/x')], emptyParse(), ctx)).toEqual([]);
  });
  it('keeps protocol-www-mix for a sitemap that sits on another variant than the site origin, and reports each URL once', () => {
    // the scan started at https://a.com; the sitemap redirected to https://www.a.com
    const ctx = baseCtx({ sitemapUrl: 'https://a.com/sitemap.xml', finalUrl: 'https://www.a.com/sitemap.xml', redirected: true });
    const f = run([rec('https://www.a.com/x'), rec('https://a.com/y'), rec('http://www.a.com/z')], emptyParse(), ctx);
    expect(f.find((x) => x.ruleId === 'protocol-www-mix')).toEqual({
      ruleId: 'protocol-www-mix', severity: 'warning', message: 'URLs mixing http/https or www/non-www with the site origin', count: 1, examples: [{ value: 'https://www.a.com/x', line: 1 }],
    });
    expect(f.find((x) => x.ruleId === 'cross-host')).toMatchObject({ count: 2, examples: [{ value: 'https://a.com/y' }, { value: 'http://www.a.com/z' }] });
  });
  it('detects fake freshness only with enough urls', () => {
    const stats = (n: number, share: number) => ({ ...emptyParse().stats, urlCount: n, topLastmodShare: share });
    expect(run([], emptyParse({ stats: stats(100, 0.95) }))).toEqual([{
      ruleId: 'fake-freshness', severity: 'warning', message: 'Nearly all URLs share one lastmod date, so it looks bulk-set', count: 1,
      examples: [{ value: '95% identical', code: 'identical-share', params: { percent: 95 } }],
    }]);
    expect(run([], emptyParse({ stats: stats(5, 1) }))).toEqual([]);
    expect(run([], emptyParse({ stats: stats(100, 0.5) }))).toEqual([]);
  });
  it('detects fake freshness from 10 urls and a 90% share, and not below either', () => {
    const stats = (n: number, share: number) => ({ ...emptyParse().stats, urlCount: n, topLastmodShare: share });
    expect(run([], emptyParse({ stats: stats(10, 0.9) })).map((f) => f.ruleId)).toEqual(['fake-freshness']);
    expect(run([], emptyParse({ stats: stats(9, 0.9) }))).toEqual([]);
    expect(run([], emptyParse({ stats: stats(10, 0.89) }))).toEqual([]);
  });
  it('flags future and stale lastmod signals', () => {
    expect(run([rec('https://a.com/x', { lastmod: '2027-01-01' })])).toEqual([{
      ruleId: 'future-lastmod', severity: 'warning', message: 'Future lastmod dates', count: 1, examples: [{ value: '2027-01-01', line: 1 }],
    }]);
    const old = emptyParse({ stats: { ...emptyParse().stats, lastmodMax: '2024-01-01' } });
    expect(run([], old)).toEqual([{
      ruleId: 'stale-sitemap', severity: 'warning', message: 'Sitemap content looks stale (no update signal within a year)', count: 1, examples: [{ value: '2024-01-01' }],
    }]);
    const fresh = emptyParse({ stats: { ...emptyParse().stats, lastmodMax: '2026-08-01' } });
    expect(run([], fresh)).toEqual([]);
  });
  it('calls a sitemap stale only when its newest signal is more than 365 days before the scan', () => {
    const stale = (lastmodMax: string, httpLastModified?: string) => run([], emptyParse({ stats: { ...emptyParse().stats, lastmodMax } }), baseCtx({ httpLastModified })).map((f) => f.ruleId);
    expect(stale('2025-08-27')).toEqual([]); // exactly 365 days before 2026-08-27
    expect(stale('2025-08-26')).toEqual(['stale-sitemap']);
    expect(stale('2025-08-26', 'Wed, 26 Aug 2026 10:00:00 GMT')).toEqual([]); // a fresh Last-Modified header is a signal too
    expect(stale('2026-08-26', 'Mon, 01 Jan 2024 00:00:00 GMT')).toEqual([]); // the newest signal counts
    expect(run([], emptyParse(), baseCtx({ httpLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' })).map((f) => f.ruleId)).toEqual(['stale-sitemap']);
  });
  it('flags redirects, empty sitemaps, dupes and utm params', () => {
    const f = run([rec('https://a.com/x?utm_source=news')],
      emptyParse({ stats: { ...emptyParse().stats, urlCount: 0, duplicateCount: 3 } }), baseCtx({ redirected: true }));
    expect(f.map((x) => [x.ruleId, x.severity, x.count])).toEqual([
      ['duplicate-urls', 'warning', 3], ['tracking-params', 'warning', 1], ['redirected-sitemap', 'warning', 1], ['empty-sitemap', 'warning', 1],
    ]);
    expect(f.find((x) => x.ruleId === 'tracking-params')!.examples).toEqual([{ value: 'https://a.com/x?utm_source=news', line: 1 }]);
    expect(f.find((x) => x.ruleId === 'redirected-sitemap')!.examples).toEqual([{ value: 'https://a.com/sitemap.xml → https://a.com/sitemap.xml' }]);
  });
  it('flags tracking parameters only when a query key starts with utm_', () => {
    const tracked = (loc: string) => run([rec(loc)]).map((f) => f.ruleId);
    expect(tracked('https://a.com/x?a=1&utm_medium=mail')).toEqual(['tracking-params']);
    expect(tracked('https://a.com/x?a=utm_source')).toEqual([]);
    expect(tracked('https://a.com/x?xutm_source=1')).toEqual([]);
  });
  it('warns on an empty sitemapindex but not on one with children', () => {
    const idx = (children: { loc: string; line: number }[]) => emptyParse({ kind: 'sitemapindex', children, stats: { ...emptyParse().stats, urlCount: 0 } });
    expect(ids(run([], idx([])))).toEqual(['empty-sitemap']);
    expect(ids(run([], idx([{ loc: 'https://a.com/a.xml', line: 2 }])))).toEqual([]);
  });
  it('validates hreflang codes and self-reference', () => {
    const f = run([
      rec('https://a.com/en/p', { alternates: [{ hreflang: 'en', href: 'https://a.com/en/p' }, { hreflang: 'zz-INVALID-!!', href: 'https://a.com/zz/p' }] }),
      rec('https://a.com/de/p', { alternates: [{ hreflang: 'en', href: 'https://a.com/en/p' }] }),
    ]);
    expect(f.map((x) => [x.ruleId, x.count])).toEqual([['invalid-hreflang', 1], ['hreflang-missing-self', 1]]);
    expect(f.find((x) => x.ruleId === 'invalid-hreflang')!.examples).toEqual([{
      value: 'zz-INVALID-!!: not a language[-script][-region] code', line: 1, code: 'hreflang-malformed', params: { value: 'zz-INVALID-!!' },
    }]);
    expect(f.find((x) => x.ruleId === 'hreflang-missing-self')!.examples).toEqual([{ value: 'https://a.com/de/p', line: 1 }]);
  });
  it('does not take a bare rel="alternate" link for an hreflang set that omits the URL itself', () => {
    expect(ids(run([rec('https://a.com/1', { alternates: [{ hreflang: '', href: 'https://m.a.com/1' }] })]))).not.toContain('hreflang-missing-self');
    // a real cluster without the URL itself is still flagged, even with a bare alternate beside it
    const f = run([rec('https://a.com/1', { alternates: [{ hreflang: '', href: 'https://m.a.com/1' }, { hreflang: 'de', href: 'https://a.com/de/1' }] })]);
    expect(f.find((x) => x.ruleId === 'hreflang-missing-self')!.examples).toEqual([{ value: 'https://a.com/1', line: 1 }]);
  });
  it('reports each bad hreflang code with its reason as the example', () => {
    const f = run([rec('https://a.com/en/p', { line: 7, alternates: [
      { hreflang: 'en-uk', href: 'https://a.com/en/p' },
      { hreflang: 'EN-gb', href: 'https://a.com/gb/p' },
      { hreflang: 'X-Default', href: 'https://a.com/' },
    ] })]).find((x) => x.ruleId === 'invalid-hreflang')!;
    expect(f.count).toBe(1);
    expect(f.examples[0]).toEqual({
      value: 'en-uk: UK is not an ISO 3166-1 code; use en-gb', line: 7,
      code: 'hreflang-uk-region', params: { value: 'en-uk', suggestion: 'en-gb' },
    });
  });
  it('counts an x-default written in another case', () => {
    const parse = emptyParse({ stats: { ...emptyParse().stats, clusterCount: 1, languages: ['en', 'X-Default'] } });
    expect(run([], parse)).toEqual([]);
  });
  it('emits info notes', () => {
    const parse = emptyParse({ stats: { ...emptyParse().stats, hasPriority: true, clusterCount: 2, languages: ['en', 'de'] } });
    expect(run([], parse).map((x) => [x.ruleId, x.severity, x.count])).toEqual([['priority-changefreq-ignored', 'info', 1], ['no-xdefault', 'info', 1]]);
  });
});

describe('content type', () => {
  const ruleIds = (contentType?: string) => run([], emptyParse(), baseCtx({ contentType })).map((f) => f.ruleId);
  it('warns on html and other unexpected types, with the type as the example', () => {
    const f = run([], emptyParse(), baseCtx({ contentType: 'text/html' })).find((x) => x.ruleId === 'unexpected-content-type')!;
    expect(f).toEqual({
      ruleId: 'unexpected-content-type', severity: 'warning', count: 1, examples: [{ value: 'text/html' }],
      message: "Unexpected Content-Type (some crawlers reject HTML responses)",
    });
    expect(ruleIds('application/json')).toEqual(['unexpected-content-type']);
    expect(ruleIds('application/xhtml+xml')).toEqual([]); // any application/*+xml
    expect(ruleIds('text/xml+rss')).toEqual(['unexpected-content-type']);
  });
  it('accepts xml, +xml, gzip, octet-stream and plain text, and says nothing without a header', () => {
    for (const ok of ['application/xml', 'text/xml', 'application/rss+xml', 'application/gzip', 'application/x-gzip', 'application/octet-stream', 'binary/octet-stream', 'application/x-gzip-compressed', 'text/plain']) {
      expect(ruleIds(ok), ok).toEqual([]);
    }
    expect(ruleIds()).toEqual([]);
  });
});

describe('hreflang-missing', () => {
  const alt = (loc: string) => rec(loc, { alternates: [{ hreflang: 'en', href: loc }] });
  const ruleIds = (records: UrlRecord[]) => run(records).map((x) => x.ruleId);

  it('counts urls without alternates once at least half have them, the first five as examples', () => {
    const records = [
      ...Array.from({ length: 8 }, (_, i) => alt(`https://a.com/l${i}`)),
      ...Array.from({ length: 7 }, (_, i) => rec(`https://a.com/n${i}`, { line: 100 + i })),
    ];
    const f = run(records).find((x) => x.ruleId === 'hreflang-missing')!;
    expect(f).toMatchObject({ severity: 'warning', count: 7 });
    expect(f.examples).toEqual([0, 1, 2, 3, 4].map((i) => ({ value: `https://a.com/n${i}`, line: 100 + i })));
  });

  it('reports at exactly half and stays silent below half, or when every url or none has alternates', () => {
    expect(ruleIds([alt('https://a.com/1'), rec('https://a.com/2')])).toEqual(['hreflang-missing']);
    expect(ruleIds([alt('https://a.com/1'), rec('https://a.com/2'), rec('https://a.com/3')])).toEqual([]);
    expect(ruleIds([alt('https://a.com/1'), alt('https://a.com/2')])).toEqual([]);
    expect(ruleIds([rec('https://a.com/1')])).toEqual([]);
  });

  it('ignores alternate links without an hreflang, such as m-dot media alternates', () => {
    const media = rec('https://a.com/1', { alternates: [{ hreflang: '', href: 'https://m.a.com/1' }] });
    expect(ruleIds([media, rec('https://a.com/2')])).not.toContain('hreflang-missing');
  });

  it('counts across record batches', () => {
    const v = new ValidationRun(baseCtx());
    v.recordBatch([alt('https://a.com/1'), alt('https://a.com/2')]);
    v.recordBatch([rec('https://a.com/3')]);
    expect(v.finish(emptyParse()).find((x) => x.ruleId === 'hreflang-missing')!.count).toBe(1);
  });
});

describe('row flags', () => {
  it('sets the bits of every per-url rule a record hit, and none on a clean record', () => {
    const records = [rec('https://a.com/ok'), rec('https://a.com/p?utm_source=x', { lastmod: 'yesterday' }), rec('not a url')];
    run(records);
    expect(records[0]!).not.toHaveProperty('flags');
    expect(records[1]!.flags).toBe(rowFlag('tracking-params') | rowFlag('invalid-lastmod'));
    expect(records[2]!.flags).toBe(rowFlag('invalid-loc'));
  });

  it('flags hreflang rules on the row and leaves sitemap-level rules off it', () => {
    const records = [
      rec('https://a.com/en/p', { alternates: [{ hreflang: 'en-uk', href: 'https://a.com/en/p' }] }),
      rec('https://a.com/de/p', { alternates: [{ hreflang: 'en', href: 'https://a.com/en/p' }] }),
      rec('https://a.com/en/p'), // a duplicate, and without alternates: both are sitemap-level here
    ];
    const f = run(records, emptyParse({ stats: { ...emptyParse().stats, duplicateCount: 1 } }));
    expect(f.map((x) => x.ruleId)).toEqual(['invalid-hreflang', 'hreflang-missing-self', 'duplicate-urls', 'hreflang-missing']);
    expect(records.map((r) => r.flags)).toEqual([rowFlag('invalid-hreflang'), rowFlag('hreflang-missing-self'), undefined]);
  });
});

describe('extension hits', () => {
  it('turns parser hits into findings on their record, with the url as the default example', () => {
    const records = [rec('https://a.com/1', { line: 2 }), rec('https://a.com/2', { line: 3 })];
    const v = new ValidationRun(baseCtx());
    v.recordBatch(records, [
      { recordIx: 1, rule: 'image-deprecated-field', line: 4, value: 'image:caption' },
      { recordIx: 1, rule: 'mobile-obsolete', line: 6 },
    ]);
    const f = v.finish(emptyParse());
    expect(f.find((x) => x.ruleId === 'mobile-obsolete')).toMatchObject({ severity: 'info', count: 1, examples: [{ value: 'https://a.com/2', line: 6 }] });
    expect(f.find((x) => x.ruleId === 'image-deprecated-field')).toMatchObject({ severity: 'info', count: 1, examples: [{ value: 'image:caption', line: 4 }] });
    expect(records.map((r) => r.flags)).toEqual([undefined, undefined]); // info rules carry no row flag
  });

  it('errors on more than 1,000 images in one url and flags that row', () => {
    const records = [rec('https://a.com/1', { images: 1000 }), rec('https://a.com/2', { images: 1001, line: 9 })];
    const f = run(records).find((x) => x.ruleId === 'image-too-many')!;
    expect(f).toMatchObject({
      severity: 'error', count: 1,
      examples: [{ value: '1,001 <image:image> elements (limit 1,000)', line: 9, code: 'ext-too-many', params: { field: 'image:image', count: 1001, max: 1000 } }],
    });
    expect(records.map((r) => r.flags)).toEqual([undefined, rowFlag('image-too-many')]);
  });
});

describe('news', () => {
  it('maps news hits to findings with their severities, and flags the row', () => {
    const records = [rec('https://a.com/n', { line: 4 })];
    const v = new ValidationRun(baseCtx());
    v.recordBatch(records, [
      { recordIx: 0, rule: 'news-missing-field', line: 5, value: 'news:title' },
      { recordIx: 0, rule: 'news-too-old', line: 5, value: '2026-01-01' },
    ]);
    const f = v.finish(emptyParse());
    expect(f.find((x) => x.ruleId === 'news-missing-field')).toMatchObject({ severity: 'error', examples: [{ value: 'news:title', line: 5 }] });
    expect(f.find((x) => x.ruleId === 'news-too-old')!.severity).toBe('warning');
    expect(records[0]!.flags).toBe(rowFlag('news-missing-field') | rowFlag('news-too-old'));
  });

  it('errors on more than 1,000 news entries in one sitemap', () => {
    const findings = (stats: Partial<SitemapStats>) => run([], emptyParse({ stats: { ...emptyParse().stats, ...stats } }));
    expect(findings({ newsCount: 1001 }).find((x) => x.ruleId === 'news-too-many')).toMatchObject({
      severity: 'error', count: 1, examples: [{ value: '1,001 <news:news> elements (limit 1,000)', code: 'ext-too-many' }],
    });
    expect(findings({ newsCount: 1000 })).toEqual([]);
    expect(findings({})).toEqual([]); // stats stored before newsCount existed have none
  });
});

describe('video', () => {
  it('maps video hits to findings; errors flag the row, deprecated tags do not', () => {
    const records = [rec('https://a.com/v', { line: 2 })];
    const v = new ValidationRun(baseCtx());
    v.recordBatch(records, [
      { recordIx: 0, rule: 'video-missing-field', line: 3, value: 'video:thumbnail_loc' },
      { recordIx: 0, rule: 'video-invalid-value', line: 3, value: '<video:rating>: "7"', code: 'ext-invalid-value', params: { field: 'video:rating', value: '7' } },
      { recordIx: 0, rule: 'video-deprecated-field', line: 3, value: 'video:category' },
    ]);
    const f = v.finish(emptyParse());
    expect(f.map((x) => [x.ruleId, x.severity, x.count])).toEqual([
      ['video-missing-field', 'error', 1], ['video-invalid-value', 'error', 1], ['video-deprecated-field', 'info', 1],
    ]);
    expect(f.find((x) => x.ruleId === 'video-invalid-value')!.examples[0]).toEqual({
      value: '<video:rating>: "7"', line: 3, code: 'ext-invalid-value', params: { field: 'video:rating', value: '7' },
    });
    expect(records[0]!.flags).toBe(rowFlag('video-missing-field') | rowFlag('video-invalid-value'));
  });
});

describe('robots.txt rules', () => {
  const robotsWith = (text: string): RobotsInfo => ({
    found: true, url: 'https://a.com/robots.txt', status: 200, sitemapUrls: ['https://a.com/sitemap.xml'], groups: parseRobotsGroups(text).groups,
  });
  const runRobots = (records: UrlRecord[], robots: RobotsInfo | null) => {
    const v = new ValidationRun(baseCtx({ robots }));
    v.recordBatch(records);
    return v.finish(emptyParse());
  };
  const robotsIds = (f: { ruleId: string }[]) => f.map((x) => x.ruleId).filter((id) => id.startsWith('robots-'));

  it('warns on URLs Googlebot may not crawl, with the deciding rule, and flags their rows', () => {
    const robots = robotsWith('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\nDisallow: /private/\nDisallow: /*.pdf$');
    const records = [rec('https://a.com/'), rec('https://a.com/private/x', { line: 4 }), rec('https://a.com/doc.pdf', { line: 7 })];
    const findings = runRobots(records, robots);
    expect(findings.find((x) => x.ruleId === 'robots-blocked')).toEqual({
      ruleId: 'robots-blocked', severity: 'warning', message: 'URLs disallowed for Googlebot by robots.txt', count: 2, examples: [
        { value: 'https://a.com/private/x: blocked by "Disallow: /private/" (robots.txt line 6)', line: 4, code: 'robots-rule', params: { url: 'https://a.com/private/x', rule: 'Disallow: /private/', robotsLine: '6' } },
        { value: 'https://a.com/doc.pdf: blocked by "Disallow: /*.pdf$" (robots.txt line 7)', line: 7, code: 'robots-rule', params: { url: 'https://a.com/doc.pdf', rule: 'Disallow: /*.pdf$', robotsLine: '7' } },
      ],
    });
    expect(records.map((r) => r.flags)).toEqual([undefined, rowFlag('robots-blocked'), rowFlag('robots-blocked')]);
    expect(rowFlag('robots-blocked')).toBe(4096);
    expect(robotsIds(findings)).toEqual(['robots-blocked']);
  });

  it('passes a robots.txt line of 1000 or more as a string without a thousands separator', () => {
    const robots = robotsWith('User-agent: *\n' + '\n'.repeat(1200) + 'Disallow: /private');
    const f = runRobots([rec('https://a.com/private/x')], robots).find((x) => x.ruleId === 'robots-blocked')!;
    expect(f.examples[0]).toMatchObject({ value: 'https://a.com/private/x: blocked by "Disallow: /private" (robots.txt line 1202)', params: { robotsLine: '1202' } });
  });

  it('counts URLs on another origin as unverified, including www and scheme variants', () => {
    const records = ['https://www.a.com/x', 'http://a.com/x', 'https://a.com:8443/x', 'https://cdn.b.com/x', 'mailto:x@a.com']
      .map((loc, i) => rec(loc, { line: i + 1 }));
    const findings = runRobots(records, robotsWith('User-agent: *\nDisallow: /'));
    expect(robotsIds(findings)).toEqual(['robots-unverified']);
    const f = findings.find((x) => x.ruleId === 'robots-unverified')!;
    expect(f).toMatchObject({ severity: 'info', count: 4 });
    expect(f.examples[0]).toEqual({ value: 'https://www.a.com/x: on another origin than robots.txt', line: 1, code: 'robots-other-origin', params: { url: 'https://www.a.com/x' } });
    expect(records.map((r) => r.flags)).toEqual([...Array.from({ length: 4 }, () => rowFlag('cross-host')), rowFlag('invalid-loc')]); // no robots-blocked bit
  });

  it('treats 5xx, 429 and network failure as unverified, never blocked', () => {
    const cases: (RobotsInfo | null)[] = [
      null,
      { found: false, url: 'https://a.com/robots.txt', status: 503, sitemapUrls: [] },
      { found: false, url: 'https://a.com/robots.txt', status: 429, sitemapUrls: [] },
    ];
    for (const robots of cases) {
      const records = [rec('https://a.com/x'), rec('https://a.com/y')];
      const findings = runRobots(records, robots);
      expect(robotsIds(findings)).toEqual(['robots-unverified']);
      expect(findings.find((x) => x.ruleId === 'robots-unverified')).toMatchObject({
        count: 2, examples: [{ code: 'robots-unreachable', value: 'https://a.com/x: robots.txt could not be read' }, { code: 'robots-unreachable' }],
      });
      expect(records.map((r) => r.flags)).toEqual([undefined, undefined]);
    }
  });

  it('reports nothing for a 4xx robots.txt', () => {
    for (const status of [403, 404, 410]) {
      expect(robotsIds(runRobots([rec('https://a.com/x')], { found: false, url: 'https://a.com/robots.txt', status, sitemapUrls: [] }))).toEqual([]);
    }
    expect(robotsIds(runRobots([rec('https://a.com/x')], robotsWith('# only comments\n')))).toEqual([]);
  });

  it('reports no robots finding for robots data stored before its status and groups were kept', () => {
    const legacy: RobotsInfo[] = [
      { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/sitemap.xml'] },
      { found: false, url: 'https://a.com/robots.txt', sitemapUrls: [] },
    ];
    for (const robots of legacy) expect(robotsIds(runRobots([rec('https://a.com/x'), rec('https://cdn.b.com/y')], robots))).toEqual([]);
  });

  it('counts URLs past the check budget as unverified', () => {
    const robots = robotsWith('User-agent: *\nDisallow: /private');
    const v = new ValidationRun(baseCtx({ robots }));
    v.robotsMeter.steps = MATCH_STEP_BUDGET + 1; // this run's own meter, as if earlier URLs had spent the budget
    v.recordBatch([rec('https://a.com/private/1'), rec('https://a.com/private/2')]);
    const findings = v.finish(emptyParse());
    expect(robotsIds(findings)).toEqual(['robots-unverified']);
    expect(findings.find((x) => x.ruleId === 'robots-unverified')).toMatchObject({ count: 2, examples: [{ code: 'robots-check-limit' }, { code: 'robots-check-limit' }] });

    const long = runRobots([rec('https://a.com/' + 'a'.repeat(8200))], robotsWith('User-agent: *\nDisallow: /'));
    expect(long.find((x) => x.ruleId === 'robots-unverified')).toMatchObject({ count: 1, examples: [{ code: 'robots-check-limit' }] });
  });

  it('counts would-be blocks from a capped robots.txt as unverified, never blocked', () => {
    const cappedWith = (text: string): RobotsInfo => {
      const { groups, capped } = parseRobotsGroups(text);
      expect(capped).toBe(true);
      return { found: true, url: 'https://a.com/robots.txt', status: 200, sitemapUrls: [], groups, capped };
    };
    const cases: [string, string][] = [
      ['User-agent: *\nDisallow: /private\n' + 'Disallow: /f\n'.repeat(5000) + 'Allow: /private/ok', 'https://a.com/private/ok'],
      ['User-agent: *\nDisallow: /\n' + 'User-agent: x\nAllow: /\n'.repeat(500) + 'User-agent: Googlebot\nAllow: /', 'https://a.com/page'],
    ];
    for (const [text, url] of cases) {
      const records = [rec(url)];
      const findings = runRobots(records, cappedWith(text));
      expect(robotsIds(findings)).toEqual(['robots-unverified']);
      expect(findings.find((x) => x.ruleId === 'robots-unverified')).toMatchObject({ count: 1, examples: [{ code: 'robots-check-limit' }] });
      expect(((records[0]!.flags ?? 0) & rowFlag('robots-blocked')) !== 0).toBe(false);
    }
  });

  it('keeps each run its own meter: a spent run does not affect the next one over the same groups', () => {
    const robots = robotsWith('User-agent: *\nDisallow: /private');
    const spent = new ValidationRun(baseCtx({ robots }));
    spent.robotsMeter.steps = MATCH_STEP_BUDGET + 1;
    const fresh = runRobots([rec('https://a.com/private/1')], robots);
    expect(robotsIds(fresh)).toEqual(['robots-blocked']);
  });
});

// Parser and validator end to end, the way core/scan.ts runs them; `lines` are the XML-tab rows the lines point into.
function scanXml(xml: string, ctx = baseCtx(), chunk = xml.length || 1) {
  const records: UrlRecord[] = [];
  const lines: string[] = [];
  const v = new ValidationRun(ctx);
  const p = new SitemapParser({ onRecords: (r, ext) => { v.recordBatch(r, ext); records.push(...r); }, onLines: (l) => lines.push(...l) }, 2000, {}, ctx.now);
  for (let i = 0; i < xml.length; i += chunk) p.write(xml.slice(i, i + chunk));
  const result = p.finish();
  return { findings: v.finish(result), records, result, lines };
}
const lineOf = (rows: string[], needle: string) => rows.findIndex((r) => r.includes(needle)) + 1;
const SM = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const finding = (f: { ruleId: string }[], id: string) => f.find((x) => x.ruleId === id) as import('./types.js').Finding | undefined;

describe('outside-sitemap-path', () => {
  const blog = (over: Partial<ValidationContext> = {}) => baseCtx({
    sitemapUrl: 'https://a.com/blog/sitemap.xml', finalUrl: 'https://a.com/blog/sitemap.xml',
    robots: { found: true, url: 'https://a.com/robots.txt', sitemapUrls: [] }, ...over,
  });

  it('warns for a URL on the same origin but outside the sitemap directory, with the directory in the example', () => {
    const records = [rec('https://a.com/blog/post', { line: 3 }), rec('https://a.com/shop/x', { line: 4 }), rec('https://a.com/blog', { line: 5 }), rec('https://a.com/blogger/x', { line: 6 })];
    const f = finding(run(records, emptyParse(), blog()), 'outside-sitemap-path')!;
    expect(f).toMatchObject({ severity: 'warning', count: 3, message: "URLs outside the sitemap's directory" });
    expect(f.examples[0]).toEqual({
      value: "https://a.com/shop/x is outside the sitemap's directory (/blog/); it only counts if the sitemap is listed in robots.txt or submitted in Search Console",
      line: 4, code: 'outside-sitemap-path', params: { url: 'https://a.com/shop/x', dir: '/blog/' },
    });
    expect(records.map((r) => r.flags)).toEqual([undefined, rowFlag('outside-sitemap-path'), rowFlag('outside-sitemap-path'), rowFlag('outside-sitemap-path')]);
  });

  it('applies to a sitemap at the site root never, and reports cross-host URLs as cross-host only', () => {
    expect(run([rec('https://a.com/anything/x')])).toEqual([]);
    const ids = run([rec('https://b.com/shop/x'), rec('http://a.com/shop/y')], emptyParse(), blog()).map((f) => f.ruleId);
    expect(ids).toEqual(['cross-host', 'not-in-robots']);
  });

  it('is skipped when robots.txt lists the sitemap (cross-submission), or the sitemap was reached through an index', () => {
    const listed = blog({ robots: { found: true, url: 'https://a.com/robots.txt', sitemapUrls: ['https://a.com/blog/sitemap.xml'] } });
    expect(run([rec('https://a.com/shop/x')], emptyParse(), listed)).toEqual([]);
    expect(run([rec('https://a.com/shop/x')], emptyParse(), blog({ viaIndex: true }))).toEqual([]);
    expect(run([rec('https://a.com/shop/x')], emptyParse(), blog({ robots: null })).map((f) => f.ruleId)).toEqual(['outside-sitemap-path', 'robots-unverified']);
  });
});

describe('duplicate-urls', () => {
  it('keeps /a, /a/ and /a#x apart, reports the exact repeats with examples, and flags those rows', () => {
    const xml = `<urlset ${SM}>${['https://a.com/a', 'https://a.com/a/', 'https://a.com/a#x', 'https://A.com:443/a', 'https://a.com/a?x=1', 'https://a.com/a', 'https://a.com/a#x']
      .map((l) => `<url><loc>${l}</loc></url>`).join('\n')}</urlset>`;
    const { findings, records, result, lines } = scanXml(xml);
    expect(result.stats.duplicateCount).toBe(3);
    const f = finding(findings, 'duplicate-urls')!;
    expect(f).toMatchObject({ severity: 'warning', count: 3 });
    const urlRow = lines.flatMap((l, i) => (l === '  <url>' ? [i + 1] : [])); // the <url> row of each entry
    expect(f.examples.map((e) => [e.value, e.line])).toEqual([['https://A.com:443/a', urlRow[3]], ['https://a.com/a', urlRow[5]], ['https://a.com/a#x', urlRow[6]]]);
    expect(records.map((r) => r.flags)).toEqual([undefined, undefined, undefined, rowFlag('duplicate-urls'), undefined, rowFlag('duplicate-urls'), rowFlag('duplicate-urls')]);
  });

  it('keeps the duplicate bit next to the bits other rules set on the same row', () => {
    const xml = `<urlset ${SM}><url><loc>https://a.com/x</loc></url><url><loc>https://a.com/x</loc><priority>7</priority></url></urlset>`;
    expect(scanXml(xml).records.map((r) => r.flags)).toEqual([undefined, rowFlag('duplicate-urls') | rowFlag('invalid-priority')]);
  });

  it('parses each loc once: the validator takes the parser URL', () => {
    const { records } = scanXml(`<urlset ${SM}><url><loc>https://a.com/x</loc></url></urlset>`);
    const first = parsedLoc(records[0]!);
    expect(first?.href).toBe('https://a.com/x');
    expect(parsedLoc(records[0]!)).toBe(first); // the instance the parser remembered, not a fresh parse
    expect(parsedLoc({ loc: 'https://a.com/x' })).not.toBe(first);
    expect(parsedLoc({ loc: 'not a url' })).toBeNull();
  });
});

describe('index entry limits', () => {
  const index = (n: number) => `<sitemapindex ${SM}>${Array.from({ length: n }, (_, i) => `<sitemap><loc>https://a.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;

  it('reports too-many-urls for an index with more than 50,000 <sitemap> entries', () => {
    expect(finding(scanXml(index(50_000)).findings, 'too-many-urls')).toBeUndefined();
    expect(finding(scanXml(index(50_001)).findings, 'too-many-urls')).toMatchObject({ severity: 'error', count: 1, examples: [{ value: '50001' }] });
  });

  it('counts index entries in the parse-truncated example', () => {
    const f = run([], emptyParse({ kind: 'sitemapindex', truncated: true, children: Array.from({ length: 7 }, (_, i) => ({ loc: `https://a.com/${i}.xml`, line: 1 })), stats: { ...emptyParse().stats, urlCount: 0 } }));
    expect(finding(f, 'parse-truncated')!.examples[0]).toMatchObject({ value: 'stopped after 7 entries', code: 'stopped-after', params: { count: 7 } });
    const one = run([], emptyParse({ kind: 'sitemapindex', truncated: true, children: [{ loc: 'https://a.com/0.xml', line: 1 }], stats: { ...emptyParse().stats, urlCount: 0 } }));
    expect(finding(one, 'parse-truncated')!.examples[0]).toMatchObject({ value: 'stopped after 1 entry', code: 'stopped-after', params: { count: 1 } });
  });
});

describe('no-xdefault', () => {
  const xhtml = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"';
  const url = (loc: string, alts: [string, string][]) => `<url><loc>${loc}</loc>${alts.map(([l, h]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${h}"/>`).join('')}</url>`;

  it('decides per cluster: one cluster with x-default does not silence the others', () => {
    const xml = `<urlset ${SM} ${xhtml}>${[
      url('https://a.com/en/1', [['en', 'https://a.com/en/1'], ['de', 'https://a.com/de/1'], ['x-default', 'https://a.com/en/1']]),
      url('https://a.com/en/2', [['en', 'https://a.com/en/2'], ['de', 'https://a.com/de/2']]),
      url('https://a.com/en/3', [['en', 'https://a.com/en/3'], ['de', 'https://a.com/de/3']]),
    ].join('')}</urlset>`;
    const { findings, result } = scanXml(xml);
    expect(result.stats).toMatchObject({ clusterCount: 3, clustersWithoutXDefault: 2 });
    expect(finding(findings, 'no-xdefault')).toMatchObject({ severity: 'info', count: 2 });
  });

  it('is silent when every cluster has an x-default, in any case', () => {
    const xml = `<urlset ${SM} ${xhtml}>${[
      url('https://a.com/en/1', [['en', 'https://a.com/en/1'], ['X-Default', 'https://a.com/en/1']]),
      url('https://a.com/en/2', [['en', 'https://a.com/en/2'], ['x-default', 'https://a.com/en/2']]),
    ].join('')}</urlset>`;
    expect(finding(scanXml(xml).findings, 'no-xdefault')).toBeUndefined();
  });
});

describe('robots.txt of a capped file', () => {
  it('counts an allowed URL as not checked as well, never as allowed-and-silent or blocked', () => {
    const { groups, capped } = parseRobotsGroups('User-agent: *\nDisallow: /private\n' + 'Disallow: /f\n'.repeat(5000));
    expect(capped).toBe(true);
    const robots: RobotsInfo = { found: true, url: 'https://a.com/robots.txt', status: 200, sitemapUrls: [], groups, capped };
    const records = [rec('https://a.com/open'), rec('https://a.com/private/x'), rec('https://other.com/x')];
    const f = run(records, emptyParse(), baseCtx({ robots }));
    expect(f.map((x) => x.ruleId).filter((id) => id.startsWith('robots-'))).toEqual(['robots-unverified']);
    expect(finding(f, 'robots-unverified')).toMatchObject({ count: 3, examples: [{ code: 'robots-check-limit' }, { code: 'robots-check-limit' }, { code: 'robots-other-origin' }] });
    expect(records.map((r) => r.flags)).toEqual([undefined, undefined, rowFlag('cross-host')]); // no robots-blocked bit anywhere
  });
});

describe('extension URLs', () => {
  const NSX = `${SM} xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"`;

  it('warns for image and video URLs that are not absolute http(s), and for an image without a loc', () => {
    const xml = `<urlset ${NSX}>
<url><loc>https://a.com/1</loc>
<image:image><image:loc>https://a.com/ok.jpg</image:loc></image:image>
<image:image><image:loc>/relative.jpg</image:loc></image:image>
<image:image><image:loc>ftp://a.com/x.jpg</image:loc></image:image>
<image:image><image:caption>no loc</image:caption></image:image>
<image:image/>
</url>
<url><loc>https://a.com/2</loc>
<video:video><video:thumbnail_loc>javascript:alert(1)</video:thumbnail_loc><video:title>t</video:title><video:description>d</video:description>
<video:content_loc>https://a.com/v.mp4</video:content_loc><video:player_loc>//a.com/p</video:player_loc></video:video>
</url></urlset>`;
    const { findings, records, lines } = scanXml(xml);
    const f = finding(findings, 'invalid-extension-url')!;
    expect(f).toMatchObject({ severity: 'warning', count: 6 });
    // an image:loc is reported on its own row, a block on its opening row
    expect(f.examples.slice(0, 5).map((e) => [e.value, e.code, e.line])).toEqual([
      ['<image:loc>: "/relative.jpg"', 'ext-invalid-value', lineOf(lines, '/relative.jpg')],
      ['<image:loc>: "ftp://a.com/x.jpg"', 'ext-invalid-value', lineOf(lines, 'ftp://a.com/x.jpg')],
      ['<image:image> has no <image:loc>', 'image-without-loc', lineOf(lines, '<image:caption>no loc') - 1],
      ['<image:image> has no <image:loc>', 'image-without-loc', lineOf(lines, '<image:image/>')],
      ['<video:thumbnail_loc>: "javascript:alert(1)"', 'ext-invalid-value', lineOf(lines, '<video:video>')],
    ]);
    expect(f.examples.slice(0, 5).map((e) => e.line)).toEqual([8, 11, 13, 16, 20]);
    expect(f.examples[1]!.params).toEqual({ field: 'image:loc', value: 'ftp://a.com/x.jpg' });
    expect(records.map((r) => r.flags)).toEqual([rowFlag('invalid-extension-url'), rowFlag('invalid-extension-url')]);
  });

  it('accepts CDATA-wrapped and entity-escaped image locs', () => {
    const xml = `<urlset ${NSX}><url><loc>https://a.com/1</loc><image:image><image:loc><![CDATA[https://a.com/a.jpg?x=1&y=2]]></image:loc></image:image><image:image><image:loc> https://a.com/b.jpg?x=1&amp;y=2 </image:loc></image:image></url></urlset>`;
    expect(finding(scanXml(xml).findings, 'invalid-extension-url')).toBeUndefined();
  });
});

describe('namespace mistakes end to end', () => {
  it('reports a mistyped extension namespace once per binding, as a warning with the prefix and URI', () => {
    const xml = `<urlset ${SM} xmlns:image="https://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">`
      + `<url xmlns:image="https://www.google.com/schemas/sitemap-image/1.1"><loc>https://a.com/1</loc></url><url xmlns:image="https://www.google.com/schemas/sitemap-image/1.1"><loc>https://a.com/2</loc></url></urlset>`;
    const f = finding(scanXml(xml).findings, 'extension-namespace-unknown')!;
    expect(f).toMatchObject({ severity: 'warning', count: 1 });
    expect(f.examples[0]).toEqual({
      value: 'xmlns:image is bound to "https://www.google.com/schemas/sitemap-image/1.1", which is not the namespace Google documents for it',
      line: 1, code: 'extension-namespace-unknown', params: { prefix: 'image', uri: 'https://www.google.com/schemas/sitemap-image/1.1' },
    });
  });

  it('also catches any prefix bound to a look-alike URI, and leaves the exact ones alone', () => {
    const exact = `<urlset ${SM} xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></urlset>`;
    expect(finding(scanXml(exact).findings, 'extension-namespace-unknown')).toBeUndefined();
    const f = finding(scanXml(`<urlset ${SM} xmlns:img="http://www.google.com/schemas/sitemap-image/1.0" xmlns:v="http://www.google.com/schemas/sitemap-video/2.0" xmlns:h="https://www.w3.org/1999/xhtml"></urlset>`).findings, 'extension-namespace-unknown')!;
    expect(f.examples.map((e) => e.params)).toEqual([
      { prefix: 'img', uri: 'http://www.google.com/schemas/sitemap-image/1.0' },
      { prefix: 'v', uri: 'http://www.google.com/schemas/sitemap-video/2.0' },
      { prefix: 'h', uri: 'https://www.w3.org/1999/xhtml' },
    ]);
  });

  it('maps the structural findings to their rules, with severities', () => {
    const xml = `<?xml version="1.0" encoding="windows-1251"?><urlset ${SM}>stray<url><loc>https://a.com/1</loc><loc>https://a.com/2</loc></url><sitemap><loc>https://a.com/s.xml</loc></sitemap><box><url><loc>https://a.com/3</loc></url></box></urlset>`;
    const { findings } = scanXml(xml);
    expect(findings.map((f) => [f.ruleId, f.severity, f.count])).toEqual([
      ['encoding-not-utf8', 'error', 1], ['duplicate-field', 'error', 1], ['wrong-entry-kind', 'error', 1], ['misplaced-element', 'warning', 2],
    ]);
  });
});

describe('site aliases', () => {
  const LOCAL = 'http://x.localhost:4000';
  const local = (over: Partial<ValidationContext> = {}) => baseCtx({
    origin: LOCAL, sitemapUrl: `${LOCAL}/sitemap.xml`, finalUrl: `${LOCAL}/sitemap.xml`,
    robots: { found: true, url: `${LOCAL}/robots.txt`, sitemapUrls: [`${LOCAL}/sitemap.xml`] }, ...over,
  });
  const aliased = (over: Partial<ValidationContext> = {}) => local({ siteAliases: ['https://prod.example'], ...over });

  it('counts a URL on an alias as the site itself, and still reports one on any other origin', () => {
    const records = [rec(`${LOCAL}/a`), rec('https://prod.example/b'), rec('https://other.example/c')];
    const f = run(records, emptyParse(), aliased());
    expect(f.map((x) => x.ruleId)).toEqual(['cross-host']);
    expect(f[0]).toMatchObject({ count: 1, examples: [{ value: 'https://other.example/c' }] });
    expect(records.map((r) => r.flags)).toEqual([undefined, undefined, rowFlag('cross-host')]);
  });

  it('reports the same URLs as cross-host without the alias', () => {
    const f = run([rec(`${LOCAL}/a`), rec('https://prod.example/b')], emptyParse(), local());
    expect(f.find((x) => x.ruleId === 'cross-host')).toMatchObject({ count: 1 });
  });

  it('checks an alias URL against robots.txt like a URL on the scan origin', () => {
    const robots: RobotsInfo = {
      found: true, url: `${LOCAL}/robots.txt`, status: 200, sitemapUrls: [`${LOCAL}/sitemap.xml`], groups: parseRobotsGroups('User-agent: *\nDisallow: /private/').groups,
    };
    const records = [rec('https://prod.example/private/x'), rec('https://prod.example/open')];
    const f = run(records, emptyParse(), aliased({ robots }));
    expect(f.find((x) => x.ruleId === 'robots-blocked')).toMatchObject({ count: 1, examples: [{ params: { url: 'https://prod.example/private/x' } }] });
    expect(records.map((r) => r.flags)).toEqual([rowFlag('robots-blocked'), undefined]);
    expect(f.map((x) => x.ruleId)).not.toContain('robots-unverified');
  });

  it('judges the sitemap directory rule by the path of an alias URL', () => {
    const blog = aliased({ sitemapUrl: `${LOCAL}/blog/sitemap.xml`, finalUrl: `${LOCAL}/blog/sitemap.xml` });
    const f = run([rec('https://prod.example/blog/p'), rec('https://prod.example/shop/q')], emptyParse(), blog);
    expect(f.find((x) => x.ruleId === 'outside-sitemap-path')).toMatchObject({ count: 1 });
  });
});
