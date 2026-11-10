import { describe, expect, it } from 'vitest';
import { MSG, PER_URL_RULES, type RuleId } from './validator.js';
import { DUPLICATE_BIT, hreflangMissingOn, ROW_FLAG_ERROR_MASK, ROW_FLAG_RULES, rowFlag, rowFlagRulesIn, rowIssue, type RowFlagRule } from './row-flags.js';

const hasRowFlag = (flags: number | undefined, rule: RowFlagRule): boolean => ((flags ?? 0) & rowFlag(rule)) !== 0;

describe('row flags', () => {
  it('pins every stored bit position', () => {
    expect(ROW_FLAG_RULES.map((r) => [r, rowFlag(r)])).toEqual([
      ['invalid-loc', 1], ['cross-host', 2], ['invalid-utf8', 4], ['loc-too-long', 8],
      ['invalid-lastmod', 16], ['future-lastmod', 32], ['invalid-changefreq', 64], ['invalid-priority', 128],
      ['protocol-www-mix', 256], ['tracking-params', 512], ['invalid-hreflang', 1024], ['hreflang-missing-self', 2048],
      ['robots-blocked', 4096], ['image-too-many', 8192], ['news-missing-field', 16384], ['news-invalid-language', 32768],
      ['news-invalid-date', 65536], ['news-too-old', 131072], ['video-missing-field', 262144], ['video-invalid-value', 524288],
      ['duplicate-urls', 1048576], ['outside-sitemap-path', 2097152], ['invalid-extension-url', 4194304],
    ]);
  });

  it('gives every per-URL error and warning rule a bit, and keeps the table inside 31 bits', () => {
    expect(ROW_FLAG_RULES.length).toBeLessThanOrEqual(31);
    expect(new Set(ROW_FLAG_RULES.map((r) => rowFlag(r))).size).toBe(ROW_FLAG_RULES.length);
    for (const [id, [severity]] of Object.entries(MSG) as [RuleId, [string, string]][]) {
      if (severity !== 'info' && PER_URL_RULES.has(id)) expect(rowFlag(id), id).not.toBe(0);
    }
  });

  it('only gives a bit to per-URL rules of error or warning severity', () => {
    for (const rule of ROW_FLAG_RULES) {
      expect(PER_URL_RULES.has(rule), `${rule} is not a per-URL rule`).toBe(true);
      expect(MSG[rule][0], rule).not.toBe('info');
    }
  });

  it('makes every error and warning rule either per-URL or listed as sitemap-level here', () => {
    const sitemapLevel = new Set<RuleId>([
      'xml-parse-error', 'invalid-root', 'missing-namespace', 'missing-loc', 'too-many-urls', 'file-too-large', 'invalid-child-loc',
      'unescaped-ampersand', 'parse-truncated', 'not-in-robots', 'fake-freshness', 'stale-sitemap',
      'redirected-sitemap', 'empty-sitemap', 'hreflang-missing', 'unexpected-content-type', 'news-too-many',
      'encoding-not-utf8', 'duplicate-field', 'wrong-entry-kind', 'misplaced-element', 'alternate-wrong-namespace', 'extension-namespace-unknown',
    ]);
    for (const [id, [severity]] of Object.entries(MSG) as [RuleId, [string, string]][]) {
      if (severity !== 'info') expect(PER_URL_RULES.has(id) || sitemapLevel.has(id), `${id} is neither per-URL nor sitemap-level`).toBe(true);
    }
  });

  it('exports the duplicate bit', () => {
    expect(DUPLICATE_BIT).toBe(rowFlag('duplicate-urls'));
    expect(DUPLICATE_BIT).not.toBe(0);
  });

  it('has no bit for sitemap-level, info or unknown rules', () => {
    for (const r of ['fake-freshness', 'hreflang-missing', 'no-xdefault', 'video-deprecated-field', 'mobile-obsolete', 'robots-unverified', 'constructor', '__proto__']) {
      expect(rowFlag(r), r).toBe(0);
    }
  });

  it('reads rows stored before flags existed as having none', () => {
    expect(hasRowFlag(undefined, 'invalid-loc')).toBe(false);
    expect(hasRowFlag(0, 'invalid-loc')).toBe(false);
    expect(hasRowFlag(1, 'invalid-loc')).toBe(true);
    expect(hasRowFlag(1 | 1024, 'invalid-hreflang')).toBe(true);
    expect(hasRowFlag(1, 'cross-host')).toBe(false);
  });

  it('derives hreflang-missing from the sitemap finding', () => {
    expect(hreflangMissingOn([])).toBe(false);
    const finding = (ruleId: string) => ({ ruleId, severity: 'warning' as const, message: 'x', count: 1, examples: [] });
    expect(hreflangMissingOn([finding('hreflang-missing')])).toBe(true);
    expect(hreflangMissingOn([finding('duplicate-urls'), finding('hreflang-missing')])).toBe(true);
    expect(hreflangMissingOn([finding('duplicate-urls'), finding('hreflang-missing-self')])).toBe(false);
  });

  it('marks exactly the error-severity rules in the error mask', () => {
    for (const rule of ROW_FLAG_RULES) expect((ROW_FLAG_ERROR_MASK & rowFlag(rule)) !== 0, rule).toBe(MSG[rule][0] === 'error');
  });

  it('gives a row its worst severity, counting a missing hreflang as a warning', () => {
    expect(rowIssue(rowFlag('tracking-params') | rowFlag('invalid-loc'), false)).toBe('error');
    expect(rowIssue(rowFlag('invalid-loc'), true)).toBe('error');
    expect(rowIssue(rowFlag('robots-blocked'), false)).toBe('warning');
    expect(rowIssue(rowFlag('robots-blocked'), true)).toBe('warning');
    expect(rowIssue(0, true)).toBe('warning');
    expect(rowIssue(0, false)).toBeUndefined();
  });

  it('lists the rules the rows of a sitemap carry, in table order', () => {
    expect(rowFlagRulesIn(rowFlag('robots-blocked') | rowFlag('invalid-loc'))).toEqual(['invalid-loc', 'robots-blocked']);
    expect(rowFlagRulesIn(0)).toEqual([]);
    expect(rowFlagRulesIn(rowFlag('invalid-extension-url'))).toEqual(['invalid-extension-url']);
  });
});
