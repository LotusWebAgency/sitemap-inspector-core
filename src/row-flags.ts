import type { RuleId } from './validator.js';
import type { Finding } from './types.js';

// Bit i of UrlRecord.flags is set when ROW_FLAG_RULES[i] hit that URL. The bits are stored in IndexedDB chunks:
// append only, never reorder, remove or reuse a position, or stored scans read wrong. Every per-URL rule of error
// or warning severity has a bit; info rules and sitemap-level rules have none. robots-blocked is Googlebot's verdict.
// core/row-flags.test.ts checks that every per-URL error/warning rule in MSG has one.
// max 31 entries; flags is a 32-bit int (bit 31 would make it negative)
export const ROW_FLAG_RULES = [
  'invalid-loc', 'cross-host', 'invalid-utf8', 'loc-too-long',
  'invalid-lastmod', 'future-lastmod', 'invalid-changefreq', 'invalid-priority',
  'protocol-www-mix', 'tracking-params', 'invalid-hreflang', 'hreflang-missing-self',
  'robots-blocked', 'image-too-many', 'news-missing-field', 'news-invalid-language',
  'news-invalid-date', 'news-too-old', 'video-missing-field', 'video-invalid-value',
  'duplicate-urls', 'outside-sitemap-path', 'invalid-extension-url',
] as const satisfies readonly RuleId[];
export type RowFlagRule = (typeof ROW_FLAG_RULES)[number];

const BITS = new Map<string, number>(ROW_FLAG_RULES.map((rule, i) => [rule, 1 << i]));

/** The bit for a rule, or 0 when the rule has no row flag. */
export function rowFlag(ruleId: string): number {
  return BITS.get(ruleId) ?? 0;
}

/** The bit the parser sets on the repeat of a URL; the validator reports it. */
export const DUPLICATE_BIT = rowFlag('duplicate-urls');

/**
 * hreflang-missing has no bit: the share of localized URLs is known only after the whole sitemap was read, and its
 * records are stored by then. A row with no alternate that carries an hreflang (a bare `rel="alternate"` link such as
 * an m-dot `media=` one doesn't count) is "missing hreflang" exactly when its sitemap carries the finding.
 */
export function hreflangMissingOn(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.ruleId === 'hreflang-missing');
}

// Rules of error severity among ROW_FLAG_RULES (core/validator.ts MSG; core/row-flags.test.ts keeps the two in step). The rest are warnings.
const ERROR_RULES: ReadonlySet<RowFlagRule> = new Set<RowFlagRule>([
  'invalid-loc', 'cross-host', 'invalid-utf8', 'loc-too-long', 'invalid-lastmod', 'invalid-changefreq', 'invalid-priority',
  'image-too-many', 'news-missing-field', 'news-invalid-language', 'news-invalid-date', 'video-missing-field', 'video-invalid-value',
]);
export const ROW_FLAG_ERROR_MASK = ROW_FLAG_RULES.reduce((mask, rule) => (ERROR_RULES.has(rule) ? mask | rowFlag(rule) : mask), 0);

/** The worst severity a row carries: its flags, plus the derived hreflang-missing (a warning). */
export function rowIssue(flags: number, missingHreflang: boolean): 'error' | 'warning' | undefined {
  if ((flags & ROW_FLAG_ERROR_MASK) !== 0) return 'error';
  return flags !== 0 || missingHreflang ? 'warning' : undefined;
}

/** The flag rules at least one row of a sitemap carries (TreeIndex.flagUnion), in table order. */
export function rowFlagRulesIn(flagUnion: number): RowFlagRule[] {
  return ROW_FLAG_RULES.filter((rule) => (flagUnion & rowFlag(rule)) !== 0);
}
