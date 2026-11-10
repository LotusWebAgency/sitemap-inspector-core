import { capValue, tooManyExample, type ExtensionHit } from './extensions.js';
import { normalizeParsed, normalizeUrl, parsedLoc } from './normalize.js';
import { hreflangProblem } from './lang-codes.js';
import {
  blockedExample, compileRobots, matchRobots, robotsMode, robotsPathOf, uncheckedExample,
  type CompiledRobots, type MatchMeter, type RobotsMode, type UncheckedCode,
} from './robots.js';
import { DUPLICATE_BIT, rowFlag } from './row-flags.js';
import { MAX_SITEMAP_BYTES, MAX_SITEMAP_URLS, MAX_URL_CHARS } from './sitemap-limits.js';
import { DAY_MS, parseW3CDate } from './w3c-date.js';
import type { ParseResult } from './parser.js';
import { aliasSiteUrl, isHttpUrl } from './url.js';
import type { Finding, FindingExample, Params, RobotsInfo, Severity, UrlRecord } from './types.js';

export interface ValidationContext {
  origin: string; sitemapUrl: string; finalUrl: string; redirected: boolean;
  httpLastModified?: string | undefined; robots: RobotsInfo | null; now: number;
  contentType?: string | undefined;  // lowercased media type of the response (./fetcher.ts mediaType)
  viaIndex?: boolean;  // reached through a parent sitemapindex — robots.txt only has to list the chain root
  siteAliases?: readonly string[] | undefined;  // a loc on one of these origins counts as the site's own (same path and query on `origin`)
}

// xsd:decimal ("1.", "+0.5", "-0" and ".5" included); the length cap only guards against abuse
const PRIORITY_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_PRIORITY_LENGTH = 64;
const CHANGEFREQ = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);
const MAX_IMAGES_PER_URL = 1000;
const MAX_NEWS_PER_SITEMAP = 1000;
// Params come from the sitemap too (tag names, namespace values): same cap as the example value.
// Own copies: a slice of a decoded read chunk keeps the whole chunk alive for the scan (structuredClone flattens it).
const ownCopy = (s: string): string => structuredClone(capValue(s));
const capExample = (ex: FindingExample): FindingExample => {
  const out: FindingExample = { ...ex, value: ownCopy(ex.value) };
  if (ex.params) {
    const p: Params = {};
    for (const [k, v] of Object.entries(ex.params)) p[k] = typeof v === 'string' ? ownCopy(v) : v;
    out.params = p;
  }
  return out;
};
const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const ISSUE_RULES = {
  'xml-error': 'xml-parse-error', 'root-element': 'invalid-root', 'namespace': 'missing-namespace', 'loc-missing': 'missing-loc',
  'encoding-not-utf8': 'encoding-not-utf8', 'duplicate-field': 'duplicate-field', 'wrong-entry-kind': 'wrong-entry-kind',
  'misplaced-element': 'misplaced-element', 'alternate-wrong-namespace': 'alternate-wrong-namespace',
  'extension-namespace-unknown': 'extension-namespace-unknown',
} as const;
const stripWww = (h: string) => h.replace(/^www\./, '');
// English rule texts, reported as Finding.message. Callers that localize findings key their own text by rule id and can
// fall back to these.
export const MSG = {
  'xml-parse-error': ['error', 'XML syntax errors'],
  'invalid-root': ['error', 'Root element is not <urlset> or <sitemapindex>'],
  'missing-namespace': ['error', 'Missing or wrong sitemap namespace on the root element'],
  'missing-loc': ['error', '<url> or <sitemap> entries without a <loc>'],
  'invalid-loc': ['error', '<loc> values that are not absolute http(s) URLs'],
  'invalid-utf8': ['error', 'URLs containing invalid UTF-8 (replacement characters)'],
  'loc-too-long': ['error', 'URLs of 2,048 characters or longer'],
  'too-many-urls': ['error', 'More than 50,000 URLs (or index entries) in one sitemap file'],
  'file-too-large': ['error', 'Uncompressed size exceeds 50 MB'],
  'cross-host': ['error', 'URLs whose scheme, host (www included) or port differs from the sitemap'],
  'invalid-lastmod': ['error', '<lastmod> values that are not valid W3C dates'],
  'invalid-changefreq': ['error', 'Invalid <changefreq> values'],
  'invalid-priority': ['error', '<priority> values outside 0.0–1.0'],
  'invalid-child-loc': ['error', 'Index entries with invalid <loc>'],
  'unescaped-ampersand': ['error', 'Unescaped & characters (write them as &amp;)'],
  'parse-truncated': ['error', 'Parsing stopped at the hard limit of 150,000 URLs or 150 MB; results are partial'],
  'image-too-many': ['error', 'URLs with more than 1,000 images'],
  'news-too-many': ['error', 'More than 1,000 news entries in one sitemap'],
  'news-missing-field': ['error', 'Required news tags missing'],
  'news-invalid-language': ['error', 'News languages that are not ISO 639 codes'],
  'news-invalid-date': ['error', 'News publication dates that are not W3C dates'],
  'video-missing-field': ['error', 'Required video tags missing'],
  'video-invalid-value': ['error', 'Video tags with invalid values'],
  'not-in-robots': ['warning', 'Sitemap is not referenced in robots.txt'],
  'protocol-www-mix': ['warning', 'URLs mixing http/https or www/non-www with the site origin'],
  'duplicate-urls': ['warning', 'Duplicate URLs'],
  'fake-freshness': ['warning', 'Nearly all URLs share one lastmod date, so it looks bulk-set'],
  'future-lastmod': ['warning', 'Future lastmod dates'],
  'stale-sitemap': ['warning', 'Sitemap content looks stale (no update signal within a year)'],
  'redirected-sitemap': ['warning', 'Sitemap URL redirects'],
  'empty-sitemap': ['warning', 'Sitemap contains no entries'],
  'tracking-params': ['warning', 'URLs carrying utm_ tracking parameters'],
  'invalid-hreflang': ['warning', 'Invalid hreflang language codes'],
  'hreflang-missing-self': ['warning', 'URLs whose hreflang set omits the URL itself'],
  'hreflang-missing': ['warning', "URLs without hreflang alternates, while at least half of this sitemap's URLs have them"],
  'news-too-old': ['warning', 'News articles published more than 2 days before the scan'],
  'robots-blocked': ['warning', 'URLs disallowed for Googlebot by robots.txt'],
  'unexpected-content-type': ['warning', 'Unexpected Content-Type (some crawlers reject HTML responses)'],
  'priority-changefreq-ignored': ['info', 'The priority and changefreq tags are present but ignored by Google'],
  'no-xdefault': ['info', 'Missing x-default entry in hreflang clusters'],
  'image-deprecated-field': ['info', 'Image tags Google no longer reads (caption, title, geo_location, license)'],
  'mobile-obsolete': ['info', '<mobile:mobile> tags, which Google ignores'],
  'video-deprecated-field': ['info', 'Video tags Google no longer reads (category, gallery_loc, price, tvshow)'],
  'robots-unverified': ['info', 'URLs not checked against robots.txt (another origin, robots.txt unreadable, or past the check limits)'],
  'encoding-not-utf8': ['error', 'XML declaration names an encoding other than UTF-8'],
  'duplicate-field': ['error', 'Entries repeating <loc>, <lastmod>, <changefreq> or <priority> (only the first is used)'],
  'wrong-entry-kind': ['error', '<url> entries in a sitemap index, or <sitemap> entries in a URL sitemap'],
  'misplaced-element': ['warning', 'Entries or text in unexpected places (entries belong directly under the root element)'],
  'alternate-wrong-namespace': ['warning', 'Alternate links outside the xhtml namespace (not read as hreflang)'],
  'extension-namespace-unknown': ['warning', 'Extension namespaces that are not the documented ones (image, video, news, mobile, xhtml)'],
  'invalid-extension-url': ['warning', 'Image or video URL tags that are missing or not absolute http(s) URLs'],
  'outside-sitemap-path': ['warning', "URLs outside the sitemap's directory"],
} as const satisfies Record<string, [Severity, string]>;
export type RuleId = keyof typeof MSG;
// Rules hit once per <url> by recordBatch. Error and warning ones need a bit in ./row-flags.ts ROW_FLAG_RULES
// (./row-flags.test.ts enforces it); add a new per-URL rule here.
export const PER_URL_RULES: ReadonlySet<RuleId> = new Set<RuleId>([
  'invalid-loc', 'invalid-utf8', 'loc-too-long', 'cross-host', 'invalid-lastmod', 'invalid-changefreq', 'invalid-priority',
  'future-lastmod', 'protocol-www-mix', 'tracking-params', 'invalid-hreflang', 'hreflang-missing-self', 'image-too-many',
  'image-deprecated-field', 'mobile-obsolete', 'news-missing-field', 'news-invalid-language', 'news-invalid-date', 'news-too-old',
  'video-missing-field', 'video-invalid-value', 'video-deprecated-field', 'robots-blocked', 'robots-unverified',
  'duplicate-urls', 'outside-sitemap-path', 'invalid-extension-url',
]);

// What servers send for sitemap files (XML, gzip, generic binary or text). Search engines document no required type.
const SITEMAP_TYPES = new Set([
  'application/xml', 'text/xml', 'application/gzip', 'application/x-gzip', 'application/octet-stream',
  'binary/octet-stream', 'application/x-gzip-compressed', 'text/plain',
]);
const APPLICATION_TOKEN = /^application\/[\w.+-]+$/;
// application/<one or more token chars>+xml; the suffix is checked apart so the pattern cannot backtrack over '+' runs
const isXmlSubtype = (v: string): boolean => v.endsWith('+xml') && v.length > 'application/+xml'.length && APPLICATION_TOKEN.test(v);
const GOOGLEBOT = 'Googlebot'; // robots-blocked is reported for this crawler; callers can evaluate other crawlers with compileRobots

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';
const IMF_FIXDATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`);
// HTTP-date as RFC 9110 §5.6.7 writes it, in any of its three forms (IMF-fixdate "Sun, 06 Nov 1994 08:49:37 GMT", obsolete RFC 850
// "Sunday, 06-Nov-94 08:49:37 GMT", asctime "Sun Nov  6 08:49:37 1994"), NaN for anything else: Date.parse would also read junk
// such as "0" (as the year 2000, in the local time zone). The weekday is not checked; years before 100 are refused because
// Date.UTC would shift them into the 1900s. A two-digit RFC 850 year that lands more than 50 years after now is the past century.
type DateParts = [day: string, month: string, year: string, hour: string, minute: string, second: string];
function dateParts(s: string): DateParts | null {
  let m = IMF_FIXDATE.exec(s) ?? RFC850_DATE.exec(s);
  if (m) return m.slice(1) as DateParts;
  m = ASCTIME_DATE.exec(s);
  if (!m) return null;
  const [month, day, hour, minute, second, year] = m.slice(1) as DateParts; // asctime puts the month first and the year last
  return [day, month, year, hour, minute, second];
}
function parseHttpDate(s: string, now: number): number {
  const parts = dateParts(s);
  if (!parts) return NaN;
  const [day, mon, yr, h, mi, sec] = parts;
  const month = MONTHS.indexOf(mon);
  const [d, hour, minute, second] = [day, h, mi, sec].map(Number) as [number, number, number, number];
  let year = Number(yr);
  if (yr.length === 2) {
    const limit = new Date(now);
    limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    year += Math.floor(new Date(now).getUTCFullYear() / 100) * 100;
    if (Date.UTC(year, month, d, hour, minute, second) > limit.getTime()) year -= 100;
  }
  if (year < 100 || hour > 23 || minute > 59 || second > 59) return NaN;
  const t = Date.UTC(year, month, d, hour, minute, second);
  const check = new Date(t);
  return check.getUTCMonth() === month && check.getUTCDate() === d ? t : NaN; // a day past the month's end rolls over
}
// Whether robots.txt (when it was read) lists this sitemap under the URL it was asked for or the one it ended up at.
function listsSitemap(robots: RobotsInfo | null, sitemapUrl: string, finalUrl: string): boolean {
  if (robots?.found !== true) return false;
  const own = [normalizeUrl(sitemapUrl), normalizeUrl(finalUrl)];
  return robots.sitemapUrls.some((s) => { const n = normalizeUrl(s); return n !== null && own.includes(n); });
}
const isWeb = (u: URL | null): u is URL => u !== null && (u.protocol === 'http:' || u.protocol === 'https:');

const entryCount = (parse: ParseResult): number => (parse.kind === 'sitemapindex' ? parse.children.length + (parse.childOverflow ?? 0) : parse.stats.urlCount);
const outsidePathMessage = (url: string, dir: string): string =>
  `${url} is outside the sitemap's directory (${dir}); it only counts if the sitemap is listed in robots.txt or submitted in Search Console`;

export class ValidationRun {
  private findings = new Map<string, Finding>();
  private host: string; private scheme: string; // the sitemap's own scheme and host:port (www and a non-default port count)
  private originScheme = ''; private originHost = ''; private originHasWww = false; // the site origin the run started from
  private dir: string | null; // the directory the sitemap's URLs must stay in; null when the rule does not apply
  private rowFlags = 0; // bits of the record recordBatch is on; hit() collects them
  private withAlternates = 0; private withoutAlternates = 0;
  private missingAlternates: FindingExample[] = []; // first five URLs without alternates
  private robotsMode: RobotsMode;
  private origin: string; // the site origin, canonical (ctx.origin as given when it is not a URL)
  private listedInRobots: boolean; // robots.txt was read and names this sitemap
  private result: Finding[] | null = null; // finish() computes once
  private googlebot: CompiledRobots | null = null; // shared and cached per RobotsInfo.groups (./robots.ts)
  readonly robotsMeter: MatchMeter = { steps: 0 }; // this run's matcher work; a test sets it to simulate a spent budget

  constructor(private ctx: ValidationContext) {
    const u = new URL(ctx.finalUrl);
    this.host = u.host; this.scheme = u.protocol;
    this.origin = ctx.origin;
    try {
      const o = new URL(ctx.origin);
      if (o.origin !== 'null') this.origin = o.origin;
      this.originScheme = o.protocol; this.originHost = stripWww(o.hostname); this.originHasWww = o.hostname.startsWith('www.');
    } catch { /* no site origin to compare with */ }
    // A sitemap may only list URLs under its own directory, unless robots.txt lists it (cross-submission) or a parent
    // index leads here (robots.txt then only has to list the chain root, Search Console may hold the rest).
    const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    this.listedInRobots = listsSitemap(ctx.robots, ctx.sitemapUrl, ctx.finalUrl);
    this.dir = dir === '/' || this.listedInRobots || ctx.viaIndex === true ? null : dir;
    this.robotsMode = robotsMode(ctx.robots);
    const groups = ctx.robots?.groups;
    if (this.robotsMode === 'rules' && groups && ctx.robots?.capped !== true) this.googlebot = compileRobots(groups, GOOGLEBOT);
  }

  private finding(ruleId: RuleId): Finding {
    let f = this.findings.get(ruleId);
    if (!f) {
      const [severity, message] = MSG[ruleId];
      f = { ruleId, severity, message, count: 0, examples: [] };
      this.findings.set(ruleId, f);
    }
    return f;
  }

  private hit(ruleId: RuleId, example?: FindingExample): Finding {
    this.rowFlags |= rowFlag(ruleId);
    const f = this.finding(ruleId);
    f.count++;
    if (example && f.examples.length < 5) f.examples.push(capExample(example));
    return f;
  }

  recordBatch(records: UrlRecord[], ext: readonly ExtensionHit[] = []): void {
    let next = 0; // ext is in record order
    for (const [i, r] of records.entries()) {
      const parserMarks = r.flags ?? 0; // bits the parser set: a repeated URL
      this.rowFlags = 0;
      const ex = { value: r.loc, line: r.line };
      const u = parsedLoc(r);
      // the loc as the site's own URL: host, path and robots checks use it, the hreflang and utm checks the loc as written
      const aliased = u ? aliasSiteUrl(u, this.origin, this.ctx.siteAliases) : u;
      const site = isWeb(aliased) ? aliased : null; // null: not an http(s) URL
      let crossHost = false;
      if (!site) this.hit('invalid-loc', ex);
      else if (site.protocol !== this.scheme || site.host !== this.host) { this.hit('cross-host', ex); crossHost = true; }
      else if (this.dir !== null && !site.pathname.startsWith(this.dir)) {
        this.hit('outside-sitemap-path', {
          value: outsidePathMessage(r.loc, this.dir), line: r.line, code: 'outside-sitemap-path', params: { url: r.loc, dir: this.dir },
        });
      }
      if (parserMarks & DUPLICATE_BIT) this.hit('duplicate-urls', ex);
      if (r.loc.includes('�')) this.hit('invalid-utf8', ex);
      if (r.loc.length >= MAX_URL_CHARS) this.hit('loc-too-long', ex);
      if (r.lastmod) this.checkLastmod(r.lastmod, r.line);
      if (r.changefreq && !CHANGEFREQ.has(r.changefreq)) this.hit('invalid-changefreq', { value: r.changefreq, line: r.line });
      if (r.priority !== undefined) {
        const p = Number(r.priority);
        if (r.priority.length > MAX_PRIORITY_LENGTH || !PRIORITY_RE.test(r.priority) || p < 0 || p > 1) {
          this.hit('invalid-priority', { value: r.priority, line: r.line });
        }
      }
      this.recordWarnings(r, u, site, crossHost);
      if (site) this.checkRobots(r, site);
      if (r.images !== undefined && r.images > MAX_IMAGES_PER_URL) {
        this.hit('image-too-many', { ...tooManyExample('image:image', r.images, MAX_IMAGES_PER_URL), line: r.line });
      }
      while (next < ext.length) {
        const h = ext[next];
        if (!h || h.recordIx > i) break;
        if (h.recordIx === i) this.extHit(h, r);
        next++;
      }
      if (this.rowFlags) r.flags = this.rowFlags;
    }
  }

  private extHit(h: ExtensionHit, r: UrlRecord): void {
    const ex: FindingExample = { value: h.value ?? r.loc, line: h.line };
    if (h.code) ex.code = h.code;
    if (h.params) ex.params = h.params;
    this.hit(h.rule, ex);
  }

  private checkLastmod(lastmod: string, line: number): void {
    const t = parseW3CDate(lastmod); // memoized with the parser's read of the same value
    if (Number.isNaN(t)) this.hit('invalid-lastmod', { value: lastmod, line });
    else if (t > this.ctx.now + DAY_MS) this.hit('future-lastmod', { value: lastmod, line });
  }

  private recordWarnings(r: UrlRecord, u: URL | null, site: URL | null, crossHost: boolean): void {
    // A URL that already failed the sitemap's own scheme/host/port check is reported once, as cross-host. What is left
    // is a sitemap that sits on another variant than the site origin the run started from (say it redirected from
    // example.com to www.example.com): its own URLs then mix with that origin.
    if (site && !crossHost && stripWww(site.hostname) === this.originHost) {
      if (site.protocol !== this.originScheme || site.hostname.startsWith('www.') !== this.originHasWww) {
        this.hit('protocol-www-mix', { value: r.loc, line: r.line });
      }
    }
    if (u) for (const k of u.searchParams.keys()) if (k.startsWith('utm_')) { this.hit('tracking-params', { value: r.loc, line: r.line }); break; }
    const clustered = r.alternates?.filter((a) => a.hreflang) ?? []; // a bare rel="alternate" (m-dot, media=) is no hreflang cluster member
    if (clustered.length > 0) this.withAlternates++;
    else {
      this.withoutAlternates++;
      if (this.missingAlternates.length < 5) this.missingAlternates.push({ value: r.loc, line: r.line });
    }
    if (clustered.length > 0) {
      for (const a of clustered) {
        const problem = hreflangProblem(a.hreflang);
        if (problem) this.hit('invalid-hreflang', { value: problem.message, line: r.line, code: problem.code, params: problem.params });
      }
      // An href written exactly like the loc is the self link; only without one is every href parsed (large sets list ~70).
      const self = u && !clustered.some((a) => a.href === r.loc) ? normalizeParsed(u) : null;
      if (self && !clustered.some((a) => normalizeUrl(a.href) === self)) this.hit('hreflang-missing-self', { value: r.loc, line: r.line });
    }
  }

  private robotsUnverified(code: UncheckedCode, r: UrlRecord): void {
    this.hit('robots-unverified', { ...uncheckedExample(code, r.loc), line: r.line });
  }

  // Googlebot's verdict for one <loc>. URLs on another origin, URLs when robots.txt answered 5xx / 429 or
  // failed, URLs past the matcher's limits and every URL when robots.txt is capped are counted as not checked, never as blocked. Legacy robots data
  // (a RobotsInfo without status or groups) gives no robots finding at all; a 4xx robots.txt blocks nothing.
  private checkRobots(r: UrlRecord, u: URL): void {
    if (this.robotsMode === 'legacy') return;
    const path = robotsPathOf(u, this.origin);
    if (path === null) { this.robotsUnverified('robots-other-origin', r); return; }
    if (this.robotsMode === 'unverified') { this.robotsUnverified('robots-unreachable', r); return; }
    // a capped robots.txt lost groups or rules, so any verdict may rest on an incomplete rule set, an "allowed" one
    // as much as a "blocked" one: not checked, never blocked
    if (this.ctx.robots?.capped === true) { this.robotsUnverified('robots-check-limit', r); return; }
    if (!this.googlebot) return;
    const v = matchRobots(this.googlebot, path, this.robotsMeter);
    if (v.kind === 'over-limit') this.robotsUnverified('robots-check-limit', r);
    else if (v.kind === 'blocked') this.hit('robots-blocked', { ...blockedExample(r.loc, v.rule), line: r.line });
  }

  /** The findings, most severe first. Computed once: a second call returns the same array, whatever parse it is given. */
  finish(parse: ParseResult): Finding[] {
    this.result ??= this.collect(parse);
    return this.result;
  }

  private collect(parse: ParseResult): Finding[] {
    for (const i of parse.issues) {
      this.hit(ISSUE_RULES[i.code], { value: i.message, ...(i.line === undefined ? {} : { line: i.line }), code: i.detail, params: i.params });
    }
    if (parse.truncated) {
      const n = entryCount(parse);
      this.hit('parse-truncated', {
        value: `stopped after ${n.toLocaleString('en-US')} ${n === 1 ? 'entry' : 'entries'}`, code: 'stopped-after', params: { count: n },
      });
    }
    const entries = entryCount(parse); // <url> entries of a urlset, <sitemap> entries of an index
    if (entries > MAX_SITEMAP_URLS) this.hit('too-many-urls', { value: String(entries) });
    if (parse.stats.byteSize > MAX_SITEMAP_BYTES) {
      const mb = Math.ceil(parse.stats.byteSize * 10 / 1_048_576) / 10; // rounded up, so a file over the limit never reads as exactly 50 MB
      this.hit('file-too-large', { value: `${mb.toLocaleString('en-US')} MB`, code: 'size-mb', params: { size: mb } });
    }
    const news = parse.stats.newsCount ?? 0;
    if (news > MAX_NEWS_PER_SITEMAP) this.hit('news-too-many', tooManyExample('news:news', news, MAX_NEWS_PER_SITEMAP));
    for (const c of parse.children) {
      if (!isHttpUrl(c.loc)) this.hit('invalid-child-loc', { value: c.loc, line: c.line });
      if (c.lastmod) this.checkLastmod(c.lastmod, c.line);
    }
    if (parse.bareAmpersands > 0) {
      const f = this.finding('unescaped-ampersand');
      f.count = parse.bareAmpersands;
      f.examples = [{ value: '&' }];
    }
    this.summaryWarnings(parse);
    return [...this.findings.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count);
  }

  private summaryWarnings(parse: ParseResult): void {
    const { ctx } = this;
    if (ctx.robots?.found === true && ctx.viaIndex !== true && !this.listedInRobots) this.hit('not-in-robots', { value: ctx.finalUrl });
    if (parse.stats.duplicateCount > 0) this.finding('duplicate-urls').count = parse.stats.duplicateCount;
    if (parse.stats.topLastmodShare >= 0.9 && parse.stats.urlCount >= 10) {
      const pct = Math.round(parse.stats.topLastmodShare * 100);
      this.hit('fake-freshness', { value: `${pct}% identical`, code: 'identical-share', params: { percent: pct } });
    }
    const signals = [
      parse.stats.lastmodMax ? parseW3CDate(parse.stats.lastmodMax) : NaN,
      ctx.httpLastModified ? parseHttpDate(ctx.httpLastModified, ctx.now) : NaN,
    ].filter((x) => !Number.isNaN(x));
    if (signals.length && Math.max(...signals) < ctx.now - 365 * DAY_MS) {
      this.hit('stale-sitemap', { value: new Date(Math.max(...signals)).toISOString().slice(0, 10) });
    }
    if (ctx.redirected) this.hit('redirected-sitemap', { value: `${ctx.sitemapUrl} → ${ctx.finalUrl}` });
    if (this.withoutAlternates > 0 && this.withAlternates >= this.withoutAlternates) {
      const f = this.finding('hreflang-missing');
      f.count = this.withoutAlternates;
      f.examples = this.missingAlternates.map(capExample);
    }
    if (ctx.contentType && !SITEMAP_TYPES.has(ctx.contentType) && !isXmlSubtype(ctx.contentType)) {
      this.hit('unexpected-content-type', { value: ctx.contentType });
    }
    if (parse.kind === 'urlset' ? parse.stats.urlCount === 0 : parse.kind === 'sitemapindex' && parse.children.length === 0) this.hit('empty-sitemap');
    if (parse.stats.hasPriority || parse.stats.hasChangefreq) this.hit('priority-changefreq-ignored');
    const withoutXDefault = parse.stats.clustersWithoutXDefault;
    if (withoutXDefault !== undefined) {
      if (withoutXDefault > 0) this.finding('no-xdefault').count = withoutXDefault; // decided per hreflang cluster
    } else if (parse.stats.clusterCount > 0 && !parse.stats.languages.some((l) => l.toLowerCase() === 'x-default')) {
      // stats without the per-cluster count (older shape)
      this.hit('no-xdefault');
    }
  }
}
