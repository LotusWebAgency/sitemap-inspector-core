import { XmlPrinter } from './printer.js';
import { XmlTokenizer, type XmlToken } from './tokenizer.js';
import { ExtensionCollector, IMAGE_NS, XHTML_NS, unknownExtensionNamespace, type ExtensionHit } from './extensions.js';
import { duplicateKey, rememberParsedLoc } from './normalize.js';
import { DUPLICATE_BIT } from './row-flags.js';
import { isValidW3CDate } from './w3c-date.js';
import { hash53 } from './hash53.js';
import type { Alternate, ExampleCode, Params, SitemapKind, SitemapStats, UrlRecord } from './types.js';

export interface IndexChild { loc: string; lastmod?: string | undefined; line: number }
// message is the English text (stored as the example value); detail + params let the UI translate it.
// code picks the finding: the first four map to the xml-parse-error, invalid-root, missing-namespace and missing-loc rules,
// every other code is its own rule id (each has its own per-code cap on stored issues).
export interface StructuralIssue {
  code: 'xml-error' | 'root-element' | 'namespace' | 'loc-missing'
    | 'encoding-not-utf8' | 'duplicate-field' | 'wrong-entry-kind' | 'misplaced-element' | 'alternate-wrong-namespace' | 'extension-namespace-unknown';
  message: string; line?: number; detail: ExampleCode; params: Params;
}
// text: read as a plain-text sitemap (one URL per line) rather than XML; finish() always sets it.
// children holds the first MAX_KEPT_CHILDREN entries, their locs cut to MAX_CHILD_LOC characters; childOverflow counts the rest.
export interface ParseResult { kind: SitemapKind; stats: SitemapStats; children: IndexChild[]; childOverflow?: number; issues: StructuralIssue[]; bareAmpersands: number; truncated: boolean; text?: boolean }
// ext carries the extension hits of exactly these records, in record order; recordIx indexes into records. onLines gets the
// XML-tab rows (core/printer.ts) in batches; every line number the parser reports is a row number there.
export interface ParseCallbacks { onRecords(records: UrlRecord[], ext: readonly ExtensionHit[]): void; onLines?: (lines: string[]) => void }
// Hard stop well above the spec limits (50k URLs / 50MB): oversized-but-real sitemaps still get
// fully analyzed and flagged, while a decompression bomb can't grow memory or IndexedDB unbounded.
export interface ParseLimits { maxBytes: number; maxUrls: number }
const DEFAULT_LIMITS: ParseLimits = { maxBytes: 150 * 1024 * 1024, maxUrls: 150_000 };

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const local = (name: string) => name.slice(name.lastIndexOf(':') + 1);
const prefixOf = (name: string) => { const i = name.indexOf(':'); return i === -1 ? '' : name.slice(0, i); };
const MAX_ISSUES_PER_CODE = 20;
const MAX_LASTMOD_DISTINCT = 1000;
const MAX_FIELD_TEXT = 8192;
const MAX_ALTERNATES = 500;
const MAX_LANGUAGES = 1000;
const MAX_NS_PREFIXES = 100;
const MAX_DEPTH = 64;
const UTF8_COMPATIBLE = /^(?:utf-8|us-ascii)$/i; // IANA names only: "utf8" is not one, and ASCII is a UTF-8 subset
const FIELD_BIT = { loc: 1, lastmod: 2, changefreq: 4, priority: 8 } as const;
const MAX_TEXT_LINE = 4096; // a text-sitemap line is kept this far; anything longer fails the 2,048-character check anyway
const SNIFF_CHARS = 8;
const MAX_SNIFF_BLANK = 65536;
// An index keeps this many children: the scan follows at most 1,000 (MAX_CHILDREN_PER_INDEX) and stops at 2,000 sitemaps.
const MAX_KEPT_CHILDREN = 4000;
const MAX_CHILD_LOC = 2049; // one past the 2,048-character limit, so a loc that is too long still shows (a copy: a slice would keep its whole source alive)
const HTTP_START = /^https?:\/\//i;

const NON_ASCII = /[\u0080-\uffff]/;

const utf8Encoder = new TextEncoder();
const utf8Scratch = new Uint8Array(65536); // encodeInto fills it and the result is read at once, so one module-level buffer is safe

function utf8Length(s: string): number {
  const first = s.search(NON_ASCII); // sitemaps are mostly ASCII: one native scan instead of a loop over every char
  if (first < 0) return s.length;
  if (s.isWellFormed()) {
    let n = first;
    let rest = first === 0 ? s : s.slice(first);
    while (rest.length) { // encodeInto stops at a whole code point when the scratch is full
      const { read, written } = utf8Encoder.encodeInto(rest, utf8Scratch);
      n += written;
      rest = rest.slice(read);
    }
    return n;
  }
  // a lone surrogate (only from a caller that split a pair; the decoder and SourceWriter never do) counts 2 here, where encodeInto would write U+FFFD, 3 bytes
  let n = first;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3; // a surrogate pair counts 2+2 = 4
  }
  return n;
}

// Walks a chunk line by line from `start`: `text(from, end)` for each non-empty stretch of a line, `newline()` at each
// '\n', '\r\n' or lone '\r'. Returns true when the chunk ends on a CR, so a '\n' that opens the next chunk belongs to it.
function eachLine(chunk: string, start: number, text: (from: number, end: number) => void, newline: () => void): boolean {
  const n = chunk.length;
  let from = start;
  let nl = -2;
  let cr = -2;
  while (from < n) {
    if (nl !== -1 && nl < from) nl = chunk.indexOf('\n', from);
    if (cr !== -1 && cr < from) cr = chunk.indexOf('\r', from);
    const br = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    const end = br === -1 ? n : br;
    if (end > from) text(from, end);
    if (br === -1) return false;
    newline();
    from = br + 1;
    if (br === cr) {
      if (from === n) return true;
      if (chunk.charCodeAt(from) === 10) from++;
    }
  }
  return false;
}

export class SitemapParser {
  // The parser always runs a printer, with or without onLines: it numbers the lines.
  private printer: XmlPrinter;
  private tk: XmlTokenizer;
  private kind: SitemapKind = 'unknown';
  private sawRoot = false;
  private rootClosed = false;
  private reportedAfterRoot = false;
  private issues: StructuralIssue[] = [];
  private issueCounts = new Map<StructuralIssue['code'], number>();
  private children: IndexChild[] = [];
  /** Index entries read past MAX_KEPT_CHILDREN: counted, not kept. */
  childOverflow = 0;
  private batch: UrlRecord[] = [];
  private extBatch: ExtensionHit[] = [];
  private ext: ExtensionCollector;
  // plain-text sitemaps: the body is sniffed first, then read line by line instead of through the tokenizer
  private mode: 'detect' | 'xml' | 'text' = 'detect';
  private textSkipLf = false; // text mode: the last chunk ended on a CR, so a LF that opens the next one is part of that break
  private sniff = ''; // everything held while detecting
  private sniffBlank = 0; // length of the whitespace run `sniff` starts with
  private lead = ''; // the first SNIFF_CHARS non-blank characters of `sniff`
  private textLine = ''; private textLen = 0; private textLineNo = 1; // textLineNo: the row the current line starts on
  // element state
  private inUrl = false; private urlLine = 1;
  private cur: { loc?: string; lastmod?: string; changefreq?: string; priority?: string; images: number; alternates: Alternate[] } = { images: 0, alternates: [] };
  private field: 'loc' | 'lastmod' | 'changefreq' | 'priority' | null = null;
  private fieldText = '';
  private fieldDup = false; // the open field repeats one of its entry: its text is dropped, the first value stays
  private seenFields = 0;   // FIELD_BIT of the fields the current <url> / <sitemap> already had
  private nsPrefixes = new Map<string, string>(); // xmlns:prefix bindings, for namespace-aware field matching
  private nsReported = new Set<string>(); // "prefix uri" bindings already reported as unknown extension namespaces
  private rootPrefix = ''; // the root's own prefix: its children belong to the sitemap namespace even when the root's binding is wrong
  private stack: string[] = []; private overflowDepth = 0;
  private inChild = false; private childLine = 1;
  // Entries whose close tag never came, by their index in `stack` (a later entry opened while they were still open). The
  // missing close is reported once by url-not-closed / close-mismatch, so the entries after it are not also called misplaced.
  private entryIdx = -1; private leakedEntries: number[] = [];
  private child: { loc?: string; lastmod?: string } = {};
  // stats
  private urlCount = 0; private byteSize = 0;
  private lastmodMin?: string; private lastmodMax?: string; private lastmodMinT = NaN; private lastmodMaxT = NaN;
  private lastmodCounts = new Map<string, number>();
  // Hashes, not strings: 53-bit hash53 values keep these sets small at 150k URLs. A collision (about 1 in 10^6 across a
  // maxed-out sitemap) would miscount one duplicate or merge two hreflang clusters, an accepted risk.
  private seen = new Set<number>(); private duplicateCount = 0;
  private languages = new Set<string>(); private clusters = new Set<number>(); private xdefaultClusters = new Set<number>();
  private hasPriority = false; private hasChangefreq = false;
  private imageCount = 0;

  private limits: ParseLimits;
  private truncated = false;

  // now: the scan clock, for extension freshness rules (news-too-old).
  constructor(private cb: ParseCallbacks, private flushSize = 2000, limits: Partial<ParseLimits> = {}, now = Date.now()) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.ext = new ExtensionCollector(now);
    this.printer = new XmlPrinter(cb.onLines);
    this.tk = new XmlTokenizer(this.printer);
  }

  /** True once a hard limit is hit — the caller should stop feeding (and cancel) the stream. */
  get overLimit(): boolean { return this.truncated; }

  /** XML-tab rows started so far (the count onLines would have delivered once finish() ran). */
  get rowCount(): number { return this.printer.line; }

  /** The root element seen so far: 'unknown' until the root start tag has been read. */
  get rootKind(): SitemapKind { return this.kind; }

  write(chunk: string): void {
    if (this.truncated) return;
    if (this.mode === 'detect') {
      // The verdict depends on the text alone, never on where the chunks end. Only the prefix is examined per chunk,
      // so a body dripped in tiny chunks costs O(n), not a trim of everything held each time.
      this.sniff += chunk;
      if (this.lead === '') {
        const rest = chunk.trimStart();
        this.sniffBlank += chunk.length - rest.length;
        this.lead = rest.slice(0, SNIFF_CHARS);
      } else if (this.lead.length < SNIFF_CHARS) {
        this.lead += chunk.slice(0, SNIFF_CHARS - this.lead.length);
      }
      const lead = this.lead;
      if (lead.length < SNIFF_CHARS && !lead.startsWith('<') && !lead.includes('\n') && this.sniffBlank <= MAX_SNIFF_BLANK) return; // too early to tell
      this.settle();
      return;
    }
    this.consume(chunk);
  }

  // Decides between XML and a plain-text sitemap (one URL per line, sitemaps.org "Text" format) and replays what was held.
  // Only a body that does not start with '<' and whose first line begins like a URL is read as text; anything else keeps
  // reporting XML problems, as before.
  private settle(): void {
    const held = this.sniff;
    const { lead, sniffBlank: blank } = this;
    this.sniff = '';
    this.mode = blank <= MAX_SNIFF_BLANK && lead !== '' && !lead.startsWith('<') && HTTP_START.test(lead) ? 'text' : 'xml';
    if (this.mode === 'text') { this.sawRoot = true; this.kind = 'urlset'; }
    if (held) this.consume(held);
  }

  private consume(chunk: string): void {
    this.byteSize += utf8Length(chunk);
    if (this.mode === 'text') this.textLines(chunk);
    else for (const t of this.tk.write(chunk)) this.take(t);
    if (this.byteSize > this.limits.maxBytes || this.urlCount > this.limits.maxUrls || this.children.length + this.childOverflow > this.limits.maxUrls) this.truncated = true;
  }

  // Plain-text sitemap: every non-empty line is a <loc>, on the row the printer starts for it.
  private textLines(chunk: string): void {
    const start = this.textSkipLf && chunk.charCodeAt(0) === 10 ? 1 : 0;
    this.textSkipLf = eachLine(chunk, start, (from, end) => {
      const row = this.printer.plain(chunk.slice(from, end));
      if (!this.textLen) this.textLineNo = row;
      this.textLen += end - from;
      if (this.textLine.length < MAX_TEXT_LINE) this.textLine = (this.textLine + chunk.slice(from, Math.min(end, from + MAX_TEXT_LINE))).slice(0, MAX_TEXT_LINE);
    }, () => { this.printer.plain('\n'); this.endTextLine(); });
  }

  private endTextLine(): void {
    const loc = this.textLine.trim();
    if (loc) {
      this.urlLine = this.textLineNo;
      this.cur = { images: 0, alternates: [] };
      this.pushRecord(loc);
    }
    this.textLine = ''; this.textLen = 0;
  }

  finish(): ParseResult {
    if (this.mode === 'detect') this.settle();
    if (this.mode === 'text') { if (this.textLen) this.endTextLine(); } else for (const t of this.tk.end()) this.take(t);
    this.printer.finish();
    const lastLine = this.printer.line || undefined; // an empty or whitespace-only document has no row, so its finding carries no line
    if (this.batch.length) { this.cb.onRecords(this.batch, this.extBatch); this.batch = []; this.extBatch = []; }
    if (!this.truncated) {
      if (!this.sawRoot) this.issue('root-element', 'no-root', {}, 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>', lastLine);
      else if (this.stack.length) {
        const count = this.stack.length + this.overflowDepth, tag = this.stack.at(-1) ?? '';
        this.issue('xml-error', 'unclosed-elements', { count, tag }, `${count.toLocaleString('en-US')} element${count === 1 ? '' : 's'} left unclosed at end of document, innermost <${tag}> (truncated file?)`, lastLine);
      }
    }
    let topLastmodShare = 0;
    if (this.urlCount > 0 && this.lastmodCounts.size > 0) {
      for (const c of this.lastmodCounts.values()) if (c > topLastmodShare) topLastmodShare = c;
      topLastmodShare /= this.urlCount;
    }
    return {
      kind: this.kind,
      children: this.children,
      childOverflow: this.childOverflow,
      issues: this.issues,
      bareAmpersands: this.tk.bareAmpersands,
      truncated: this.truncated,
      text: this.mode === 'text',
      // stats live as long as the scan: own copies, since a slice of the read text keeps its whole chunk alive
      stats: {
        urlCount: this.urlCount, byteSize: this.byteSize,
        lastmodMin: structuredClone(this.lastmodMin), lastmodMax: structuredClone(this.lastmodMax), topLastmodShare,
        duplicateCount: this.duplicateCount,
        languages: structuredClone([...this.languages]), clusterCount: this.clusters.size,
        clustersWithoutXDefault: this.clusters.size - this.xdefaultClusters.size,
        hasPriority: this.hasPriority, hasChangefreq: this.hasChangefreq,
        imageCount: this.imageCount,
        newsCount: this.ext.blockCount('news'),
        videoCount: this.ext.blockCount('video'),
      },
    };
  }

  private issue(code: StructuralIssue['code'], detail: ExampleCode, params: Params, message: string, line?: number): void {
    const count = this.issueCounts.get(code) ?? 0;
    if (count >= MAX_ISSUES_PER_CODE) return;
    this.issueCounts.set(code, count + 1);
    this.issues.push(line === undefined ? { code, message, detail, params } : { code, message, line, detail, params });
  }

  // A prefixed element only counts as a sitemap field when its prefix is bound to the sitemap
  // namespace — otherwise <image:loc> would overwrite the page's own <loc>.
  private isSitemapName(raw: string): boolean {
    const p = prefixOf(raw);
    return p === '' || p === this.rootPrefix || this.nsPrefixes.get(p) === SITEMAP_NS;
  }

  // The namespace URI bound to a prefixed name; unprefixed names never count as extension elements.
  private nsOf(raw: string): string | undefined {
    const p = prefixOf(raw);
    return p ? this.nsPrefixes.get(p) : undefined;
  }

  private take(t: XmlToken): void {
    if (t.type === 'error') { this.issue('xml-error', t.code, t.params, t.message, t.line); return; }
    if (t.type === 'xmldecl') {
      if (t.encoding !== '' && !UTF8_COMPATIBLE.test(t.encoding)) this.issue('encoding-not-utf8', 'encoding-not-utf8', { encoding: t.encoding }, `Sitemap declares ${t.encoding} encoding; sitemaps must be UTF-8`, t.line);
      return;
    }
    if (this.rootClosed) {
      if (t.type === 'close') {
        if (!this.reportedAfterRoot) this.closeElement(t);
      } else if (!this.reportedAfterRoot) {
        this.reportedAfterRoot = true;
        this.issue('xml-error', 'content-after-root', {}, 'unexpected content after the root element', t.line);
      }
      return;
    }
    if (t.type === 'open') {
      const name = local(t.name);
      // attrs is a plain object the tokenizer filled with own keys only, so for-in visits what Object.entries would
      for (const k in t.attrs) {
        if (!k.startsWith('xmlns:')) continue;
        const prefix = k.slice(6);
        const v = t.attrs[k] ?? '';
        if (this.nsPrefixes.size < MAX_NS_PREFIXES || this.nsPrefixes.has(prefix)) this.nsPrefixes.set(prefix, v);
        this.checkBinding(prefix, v, t.line);
      }
      const depthBefore = this.overflowDepth ? -1 : this.stack.length; // -1: nesting too deep to tell
      const parentBefore = this.stack.at(-1);
      if (!t.selfClosing && !(this.sawRoot && this.kind === 'unknown')) {
        if (this.stack.length < MAX_DEPTH) this.stack.push(t.name); else this.overflowDepth++;
      }
      if (!this.sawRoot) {
        this.sawRoot = true;
        if (name === 'urlset') this.kind = 'urlset';
        else if (name === 'sitemapindex') this.kind = 'sitemapindex';
        else { this.stack = []; this.issue('root-element', 'wrong-root', { tag: t.name }, `root element is <${t.name}>, expected <urlset> or <sitemapindex>`, t.line); return; }
        const rootPrefix = prefixOf(t.name);
        this.rootPrefix = rootPrefix;
        this.rootClosed = t.selfClosing;
        const rootNs = t.attrs[rootPrefix ? `xmlns:${rootPrefix}` : 'xmlns'];
        if (rootNs !== SITEMAP_NS) {
          const attr = rootPrefix ? `xmlns:${rootPrefix}` : 'xmlns';
          this.issue('namespace', 'wrong-namespace', { attr, value: rootNs ?? '', expected: SITEMAP_NS }, `root ${attr} is "${rootNs ?? ''}", expected "${SITEMAP_NS}"`, t.line);
        }
        return;
      }
      if ((name === 'url' && this.kind === 'sitemapindex') || (name === 'sitemap' && this.kind === 'urlset')) {
        if (!this.inUrl && !this.inChild && this.isSitemapName(t.name)) { // the entry is dropped; its children never arm a field
          const root = this.kind;
          this.issue('wrong-entry-kind', 'wrong-entry-kind', { found: name, root }, `<${name}> entry inside <${root}> is ignored; use <url> in a <urlset> and <sitemap> in a <sitemapindex>`, t.line);
        }
        return;
      }
      const sitemapName = this.isSitemapName(t.name);
      if (sitemapName && ((name === 'url' && this.kind === 'urlset') || (name === 'sitemap' && this.kind === 'sitemapindex'))) {
        if (!this.inUrl && !this.inChild && !this.leakedEntries.length && parentBefore !== undefined && depthBefore > 1) {
          const parent = local(parentBefore);
          this.issue('misplaced-element', 'misplaced-element', { parent }, `unexpected entry or text inside <${parent}>; entries belong directly under the root element`, t.line);
        }
        if ((this.inUrl || this.inChild) && this.entryIdx >= 0 && this.entryIdx < this.stack.length) this.leakedEntries.push(this.entryIdx);
        this.entryIdx = !t.selfClosing && depthBefore >= 0 && this.stack.length === depthBefore + 1 ? depthBefore : -1;
      }
      if (sitemapName && name === 'url' && this.kind === 'urlset') {
        // A self-closed <url/> can't carry a <loc>; entering url state would leak it onto
        // the next element instead, since no matching close token ever arrives.
        if (t.selfClosing) { this.issue('loc-missing', 'url-without-loc', {}, 'url entry has no <loc>', t.line); return; }
        if (this.inUrl) { // previous <url> never closed: report it and keep its record if it had a loc
          this.issue('xml-error', 'url-not-closed', { line: String(t.line), openLine: String(this.urlLine) }, `<url> opened at line ${t.line} before the <url> from line ${this.urlLine} was closed`, t.line);
          if (this.cur.loc) this.pushRecord(this.cur.loc);
        }
        this.ext.endUrl(); // drops what a <url> without <loc> left behind
        this.inUrl = true; this.urlLine = t.line; this.cur = { images: 0, alternates: [] }; this.seenFields = 0; return;
      }
      if (sitemapName && name === 'sitemap' && this.kind === 'sitemapindex') {
        if (t.selfClosing) { this.issue('loc-missing', 'sitemap-without-loc', {}, 'sitemap entry has no <loc>', t.line); return; }
        this.inChild = true; this.childLine = t.line; this.child = {}; this.seenFields = 0; return;
      }
      if (this.inUrl) this.ext.open(this.nsOf(t.name), name, t.line, t.selfClosing);
      if (this.inUrl && name === 'image' && this.nsOf(t.name) === IMAGE_NS) { this.cur.images++; return; }
      if ((this.inUrl || this.inChild) && this.isSitemapName(t.name) && (name === 'loc' || name === 'lastmod' || name === 'changefreq' || name === 'priority')) {
        const bit = FIELD_BIT[name];
        const repeated = (this.seenFields & bit) !== 0;
        this.seenFields |= bit;
        if (repeated) this.issue('duplicate-field', 'duplicate-field', { field: name }, `<${name}> appears more than once in one entry; only the first is used`, t.line);
        if (t.selfClosing) return; // empty element — must not leave field state armed for later text
        this.field = name; this.fieldText = ''; this.fieldDup = repeated; return;
      }
      if (this.inUrl && name === 'link' && t.attrs['rel'] === 'alternate') {
        // Google reads only <xhtml:link>; a link in any other namespace is not an hreflang alternate.
        const p = prefixOf(t.name);
        if ((p ? this.nsPrefixes.get(p) : t.attrs['xmlns']) !== XHTML_NS) {
          const tag = t.name.slice(0, 100);
          this.issue('alternate-wrong-namespace', 'alternate-wrong-namespace', { name: tag }, `<${tag} rel="alternate"> is not in the xhtml namespace (${XHTML_NS}), so it is not read as an hreflang alternate`, t.line);
          return;
        }
        const href = t.attrs['href'];
        if (href && this.cur.alternates.length < MAX_ALTERNATES) this.cur.alternates.push({ hreflang: t.attrs['hreflang'] ?? '', href });
      }
      return;
    }
    if (t.type === 'text') {
      if (this.field && this.fieldText.length < MAX_FIELD_TEXT) this.fieldText = (this.fieldText + t.text).slice(0, MAX_FIELD_TEXT);
      if (this.inUrl) this.ext.text(t.text);
      else if (!this.inChild && this.kind !== 'unknown' && !this.overflowDepth && this.stack.length === 1 && t.text.trim()) {
        const parent = local(this.stack[0] ?? '');
        this.issue('misplaced-element', 'misplaced-element', { parent }, `unexpected entry or text inside <${parent}>; entries belong directly under the root element`, t.line);
      }
      return;
    }
    // close
    this.closeElement(t);
    if (this.sawRoot && this.kind !== 'unknown' && !this.stack.length && !this.overflowDepth) this.rootClosed = true;
    const name = local(t.name);
    if (this.inUrl) this.ext.close(this.nsOf(t.name), name);
    if (this.field && name === this.field && this.isSitemapName(t.name)) {
      const v = this.fieldText.trim();
      if (!this.fieldDup) { // a repeat leaves the first value in place
        if (this.inUrl) {
          switch (this.field) {
            case 'loc': this.cur.loc = v; break;
            case 'lastmod': this.cur.lastmod = v; break;
            case 'changefreq': this.cur.changefreq = v; break;
            case 'priority': this.cur.priority = v; break;
          }
        } else if (this.inChild && (this.field === 'loc' || this.field === 'lastmod')) {
          this.child[this.field] = v;
        }
      }
      this.field = null; this.fieldText = ''; this.fieldDup = false;
      return;
    }
    if (name === 'url' && this.inUrl && this.isSitemapName(t.name)) {
      this.inUrl = false;
      const loc = this.cur.loc;
      if (!loc) { this.issue('loc-missing', 'url-without-loc', {}, 'url entry has no <loc>', this.urlLine); return; }
      this.pushRecord(loc);
      return;
    }
    if (name === 'sitemap' && this.inChild && this.isSitemapName(t.name)) {
      this.inChild = false;
      if (this.child.loc) {
        if (this.children.length < MAX_KEPT_CHILDREN) this.children.push({ loc: structuredClone(this.child.loc.slice(0, MAX_CHILD_LOC)), lastmod: this.child.lastmod, line: this.childLine });
        else this.childOverflow++;
      }
      else this.issue('loc-missing', 'sitemap-without-loc', {}, 'sitemap entry has no <loc>', this.childLine);
      return;
    }
  }

  // Reports an xmlns:prefix binding that looks like a mistyped extension namespace, once per distinct binding.
  private checkBinding(prefix: string, uri: string, line: number): void {
    if (!unknownExtensionNamespace(prefix, uri)) return;
    const key = `${prefix} ${uri}`;
    if (this.nsReported.has(key) || this.nsReported.size >= MAX_NS_PREFIXES) return;
    this.nsReported.add(key);
    const shown = uri.slice(0, 300);
    this.issue('extension-namespace-unknown', 'extension-namespace-unknown', { prefix, uri: shown }, `xmlns:${prefix} is bound to "${shown}", which is not the namespace Google documents for it`, line);
  }

  private closeElement(t: Extract<XmlToken, { type: 'close' }>): void {
    if (this.kind === 'unknown' && this.sawRoot) return; // not a sitemap: the invalid-root issue says it all
    if (this.overflowDepth) { this.overflowDepth--; return; }
    const top = this.stack.at(-1);
    if (top === t.name) { this.stack.pop(); this.dropClosedLeaks(); return; }
    const at = this.stack.lastIndexOf(t.name);
    if (at === -1) {
      if (top === undefined) this.issue('xml-error', 'unexpected-close', { tag: t.name }, `unexpected closing tag </${t.name}>`, t.line);
      else this.issue('xml-error', 'close-mismatch', { tag: t.name, open: top }, `closing tag </${t.name}> does not match open <${top}>`, t.line);
      return;
    }
    this.issue('xml-error', 'close-mismatch', { tag: t.name, open: top ?? '' }, `closing tag </${t.name}> does not match open <${top}>`, t.line);
    this.stack.length = at;
    this.dropClosedLeaks();
  }

  private dropClosedLeaks(): void {
    if (this.leakedEntries.length) this.leakedEntries = this.leakedEntries.filter((i) => i < this.stack.length);
  }

  private pushRecord(loc: string): void {
    const recordIx = this.batch.length;
    for (const h of this.ext.endUrl()) this.extBatch.push({ ...h, recordIx });
    const r: UrlRecord = { loc, line: this.urlLine };
    if (this.cur.lastmod) r.lastmod = this.cur.lastmod;
    if (this.cur.changefreq) { r.changefreq = this.cur.changefreq; this.hasChangefreq = true; }
    if (this.cur.priority) { r.priority = this.cur.priority; this.hasPriority = true; }
    if (this.cur.images) { r.images = this.cur.images; this.imageCount += this.cur.images; }
    if (this.cur.alternates.length) {
      r.alternates = this.cur.alternates;
      for (const a of this.cur.alternates) if (a.hreflang && (this.languages.size < MAX_LANGUAGES || this.languages.has(a.hreflang))) this.languages.add(a.hreflang);
      const cluster = hash53(this.cur.alternates.map((a) => a.href).sort().join('|'));
      this.clusters.add(cluster);
      if (this.cur.alternates.some((a) => a.hreflang.toLowerCase() === 'x-default')) this.xdefaultClusters.add(cluster);
    }
    this.urlCount++;
    if (r.lastmod) {
      const t = isValidW3CDate(r.lastmod) ? Date.parse(r.lastmod) : NaN;
      if (!Number.isNaN(t)) {
        if (Number.isNaN(this.lastmodMinT) || t < this.lastmodMinT) { this.lastmodMin = r.lastmod; this.lastmodMinT = t; }
        if (Number.isNaN(this.lastmodMaxT) || t > this.lastmodMaxT) { this.lastmodMax = r.lastmod; this.lastmodMaxT = t; }
      }
      // past the distinct cap, only values already tracked keep counting
      const seenCount = this.lastmodCounts.get(r.lastmod);
      if (seenCount !== undefined) this.lastmodCounts.set(r.lastmod, seenCount + 1);
      else if (this.lastmodCounts.size < MAX_LASTMOD_DISTINCT) this.lastmodCounts.set(r.lastmod, 1);
    }
    let url: URL | null = null;
    try { url = new URL(r.loc); } catch { /* not absolute: the validator reports it */ }
    rememberParsedLoc(r, url);
    const key = url && duplicateKey(url);
    if (key) {
      const h = hash53(key);
      if (this.seen.has(h)) { this.duplicateCount++; r.flags = DUPLICATE_BIT; } else this.seen.add(h); // the validator reports the marked repeat and keeps the bit
    }
    this.batch.push(r);
    if (this.batch.length >= this.flushSize) { this.cb.onRecords(this.batch, this.extBatch); this.batch = []; this.extBatch = []; }
  }
}
