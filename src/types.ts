export type SitemapKind = 'urlset' | 'sitemapindex' | 'unknown';
export type Severity = 'error' | 'warning' | 'info';

export interface Alternate { hreflang: string; href: string }

export interface UrlRecord {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
  alternates?: Alternate[];
  images?: number;           // count of <image:image> blocks; urls without images omit it
  flags?: number;            // finding bits (row-flags.ts); omitted when none
  line: number;
}

/** Why an hreflang value is invalid (lang-codes.ts). */
export type HreflangExampleCode =
  | 'hreflang-malformed' | 'hreflang-unknown-language' | 'hreflang-unknown-script' | 'hreflang-unknown-region'
  | 'hreflang-region-only' | 'hreflang-numeric-region' | 'hreflang-uk-region';

/** Codes for example values that are prose (tokenizer/parser diagnostics, summary values). URL and data examples carry none. */
export type ExampleCode =
  | 'unterminated-comment' | 'unterminated-cdata' | 'unterminated-pi' | 'unterminated-declaration'
  | 'unterminated-markup' | 'markup-too-long' | 'malformed-close-tag' | 'malformed-tag' | 'unterminated-content'
  | 'no-root' | 'unclosed-elements' | 'wrong-root' | 'wrong-namespace' | 'url-without-loc' | 'url-not-closed'
  | 'unexpected-close' | 'close-mismatch' | 'content-after-root'
  | 'stopped-after' | 'size-mb' | 'identical-share' | 'ext-too-many' | 'ext-too-long' | 'ext-invalid-value' | HreflangExampleCode
  | 'robots-rule' | 'robots-other-origin' | 'robots-unreachable' | 'robots-check-limit'
  | 'encoding-not-utf8' | 'duplicate-field' | 'wrong-entry-kind' | 'misplaced-element' | 'alternate-wrong-namespace'
  | 'extension-namespace-unknown' | 'sitemap-without-loc' | 'image-without-loc' | 'outside-sitemap-path';

// value is the English text (or the raw URL/value), so a finding renders without a code lookup; code and params let callers localize it.
export interface FindingExample { value: string; line?: number; code?: ExampleCode; params?: Params }

export interface Finding {
  ruleId: string;            // stable rule id; localize with params, or fall back to message
  severity: Severity;
  message: string;           // English text
  params?: Params;
  count: number;
  examples: FindingExample[]; // capped at 5
}

export interface SitemapStats {
  urlCount: number;
  byteSize: number;          // UTF-8 bytes of the decoded (uncompressed) text
  lastmodMin?: string | undefined;
  lastmodMax?: string | undefined;
  topLastmodShare: number;   // 0..1, share of most frequent lastmod value (0 when none)
  duplicateCount: number;
  languages: string[];       // distinct hreflang codes seen
  clusterCount: number;      // distinct hreflang clusters
  hasPriority: boolean;
  hasChangefreq: boolean;
  imageCount: number;        // total <image:image> blocks across the sitemap
  newsCount?: number;        // <news:news> blocks; absent in older result data
  videoCount?: number;       // <video:video> blocks; absent in older result data
  clustersWithoutXDefault?: number; // hreflang clusters with no x-default entry; absent in older result data
}

/** One Allow / Disallow line of a robots.txt group (robots.ts). */
export interface RobotsRule {
  allow: boolean;
  path: string;              // the value as written, trimmed, comment removed; ≤ 2,048 chars
  line: number;              // 1-based line in robots.txt
}

/** Consecutive User-agent lines and the rules after them. agents are lowercased product tokens; '*' means any crawler. */
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }

export interface RobotsInfo {
  found: boolean;
  url: string;
  sitemapUrls: string[];
  status?: number;           // HTTP status of the robots.txt fetch; absent in older result data
  groups?: RobotsGroup[];    // crawler access rules, present when found; absent in older result data
  capped?: boolean;          // groups, rules or lines past the caps (500 / 5,000 / 2,048-char path / 512 KiB read) were dropped, so every verdict for that robots.txt is reported as robots-unverified, never blocked or allowed
}


/** Values for a message's {placeholders}; numbers are formatted in the caller's language. */
export type Params = Record<string, string | number>;
