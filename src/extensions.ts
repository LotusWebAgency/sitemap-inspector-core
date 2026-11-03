import { knownLanguage } from './lang-codes.js';
import { isFullW3CDate } from './w3c-date.js';
import { isHttpUrl } from './url.js';
import type { ExampleCode, Params } from './types.js';

// Google's sitemap extensions, identified by namespace URI (never by prefix).
export const IMAGE_NS = 'http://www.google.com/schemas/sitemap-image/1.1';
export const MOBILE_NS = 'http://www.google.com/schemas/sitemap-mobile/1.0';
export const NEWS_NS = 'http://www.google.com/schemas/sitemap-news/0.9';
export const VIDEO_NS = 'http://www.google.com/schemas/sitemap-video/1.1';
export const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// The prefix every Google example uses for each namespace; a binding of that name to any other URI is a typo.
const NS_BY_PREFIX = new Map([['image', IMAGE_NS], ['video', VIDEO_NS], ['news', NEWS_NS], ['mobile', MOBILE_NS], ['xhtml', XHTML_NS]]);
const KNOWN_NS = new Set(NS_BY_PREFIX.values());

// A URI on the host and path where Google documents the image, video, news and mobile namespaces (www.google.com, a path
// with "sitemap" under /schemas/) or the xhtml one (www.w3.org/1999/xhtml) is meant as that namespace, so it has to be the
// exact one: a different scheme, a trailing slash, other case or a typo in the path is a mistake. Other URIs, a W3C
// page such as www.w3.org/TR/xhtml1 among them, are not ours to judge.
function nearKnownNamespace(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const path = u.pathname.toLowerCase();
  if (u.hostname === 'www.google.com') return path.startsWith('/schema') && path.includes('sitemap');
  return u.hostname === 'www.w3.org' && path.startsWith('/1999/xh');
}

/**
 * Whether `xmlns:prefix="uri"` looks like a mistyped extension namespace: a prefix named image, video, news,
 * mobile or xhtml bound to a URI other than that extension's exact one, or any prefix bound to a URI that is
 * one of the exact URIs with a wrong scheme, trailing slash, case or typo (see nearKnownNamespace).
 */
export function unknownExtensionNamespace(prefix: string, uri: string): boolean {
  const want = NS_BY_PREFIX.get(prefix.toLowerCase());
  if (want !== undefined) return uri !== want;
  return !KNOWN_NS.has(uri) && nearKnownNamespace(uri);
}

// One cap for every example value and string param, applied where a hit is created and again by the validator.
export const EXAMPLE_MAX = 300;
export const capValue = (v: string): string => (v.length > EXAMPLE_MAX ? v.slice(0, EXAMPLE_MAX) + '…' : v);

/** Extension rules found while parsing; ./validator.ts turns them into findings (texts in MSG). */
export type ExtRuleId =
  | 'image-deprecated-field' | 'mobile-obsolete'
  | 'news-missing-field' | 'news-invalid-language' | 'news-invalid-date' | 'news-too-old'
  | 'video-missing-field' | 'video-invalid-value' | 'video-deprecated-field' | 'invalid-extension-url';

/** One extension problem of one <url>. Without a value, the finding example shows the URL's <loc>. */
export interface ExtensionHit { recordIx: number; rule: ExtRuleId; line: number; value?: string; code?: ExampleCode; params?: Params }
export type ExtensionDraft = Omit<ExtensionHit, 'recordIx'>;
export interface ExtExample { value?: string; code?: ExampleCode; params?: Params }

export const MAX_EXT_HITS_PER_URL = 20;
const IMAGE_DEPRECATED = new Set(['caption', 'title', 'geo_location', 'license']);

export const MAX_EXT_VALUE = 2048;
const DAY_MS = 86_400_000;

// One field of an open block: its first occurrence's text (<= MAX_EXT_VALUE chars), that text's full length, and
// how often the field appeared in the block.
interface BlockField { text: string; length: number; count: number }
interface Block { line: number; fields: Map<string, BlockField> }
interface BlockSpec { element: string; fields: ReadonlySet<string>; check(block: Block, c: ExtensionCollector): void }

// A field's trimmed text; '' when the field is missing or empty.
const fieldText = (b: Block, name: string): string => b.fields.get(name)?.text.trim() ?? '';

/** Google News: an ISO 639 language of 2 or 3 letters, or zh-cn / zh-tw; any case. */
export function newsLanguage(v: string): boolean {
  const lower = v.toLowerCase();
  return lower === 'zh-cn' || lower === 'zh-tw' || knownLanguage(lower);
}

const NEWS_FIELDS = ['publication', 'name', 'language', 'publication_date', 'title'] as const;

// news:publication only holds name and language, so being there is enough for it.
function checkNews(b: Block, c: ExtensionCollector): void {
  for (const name of NEWS_FIELDS) {
    if (name === 'publication' ? !b.fields.has(name) : !fieldText(b, name)) c.emit('news-missing-field', b.line, { value: `news:${name}` });
  }
  const language = fieldText(b, 'language');
  if (language && !newsLanguage(language)) c.emit('news-invalid-language', b.line, { value: language });
  const date = fieldText(b, 'publication_date');
  if (!date) return;
  if (!isFullW3CDate(date)) c.emit('news-invalid-date', b.line, { value: date });
  else if (Date.parse(date) < c.now - 2 * DAY_MS) c.emit('news-too-old', b.line, { value: date });
}

const VIDEO_REQUIRED = ['thumbnail_loc', 'title', 'description'] as const;
const VIDEO_YES_NO = ['family_friendly', 'requires_subscription', 'live'] as const;
const VIDEO_DATES = ['publication_date', 'expiration_date'] as const;
const VIDEO_DEPRECATED = ['category', 'gallery_loc', 'price', 'tvshow'] as const;
const VIDEO_FIELDS = new Set<string>([
  ...VIDEO_REQUIRED, 'content_loc', 'player_loc', 'duration', 'rating', ...VIDEO_YES_NO, ...VIDEO_DATES, 'tag', 'uploader', ...VIDEO_DEPRECATED,
]);
const VIDEO_URLS = ['thumbnail_loc', 'content_loc', 'player_loc'] as const;
const MAX_DESCRIPTION = 2048;
const MAX_DURATION = 28_800; // seconds
const MAX_RATING = 5;
const MAX_TAGS = 32;
const MAX_UPLOADER = 255;
const DURATION = /^\d{1,6}$/;
const RATING = /^\d{1,2}(?:\.\d{1,6})?$/;
const YES_NO = /^(?:yes|no)$/i;

// A field's full length: exact (trimmed) when it fit the cap, else the raw count of every char that arrived.
function lengthOf(b: Block, name: string): number {
  const f = b.fields.get(name);
  if (!f) return 0;
  return f.length > MAX_EXT_VALUE ? f.length : f.text.trim().length;
}

function checkVideo(b: Block, c: ExtensionCollector): void {
  for (const name of VIDEO_REQUIRED) if (!fieldText(b, name)) c.emit('video-missing-field', b.line, { value: `video:${name}` });
  if (!fieldText(b, 'content_loc') && !fieldText(b, 'player_loc')) c.emit('video-missing-field', b.line, { value: 'video:content_loc / video:player_loc' });
  for (const name of VIDEO_URLS) {
    const v = fieldText(b, name);
    if (v && !isHttpUrl(v)) c.emit('invalid-extension-url', b.line, invalidValueExample(`video:${name}`, v));
  }
  const invalid = (example: ExtExample) => c.emit('video-invalid-value', b.line, example);
  // An optional tag that is there must hold a valid value, so an empty one is invalid.
  const optional = (name: string): string | undefined => (b.fields.has(name) ? fieldText(b, name) : undefined);
  const description = lengthOf(b, 'description');
  if (description > MAX_DESCRIPTION) invalid(tooLongExample('video:description', description, MAX_DESCRIPTION));
  const duration = optional('duration');
  if (duration !== undefined && !(DURATION.test(duration) && Number(duration) >= 1 && Number(duration) <= MAX_DURATION)) {
    invalid(invalidValueExample('video:duration', duration));
  }
  const rating = optional('rating');
  if (rating !== undefined && !(RATING.test(rating) && Number(rating) <= MAX_RATING)) invalid(invalidValueExample('video:rating', rating));
  for (const name of VIDEO_YES_NO) {
    const v = optional(name);
    if (v !== undefined && !YES_NO.test(v)) invalid(invalidValueExample(`video:${name}`, v));
  }
  for (const name of VIDEO_DATES) {
    const v = optional(name);
    if (v !== undefined && !isFullW3CDate(v)) invalid(invalidValueExample(`video:${name}`, v));
  }
  const tags = b.fields.get('tag')?.count ?? 0;
  if (tags > MAX_TAGS) invalid(tooManyExample('video:tag', tags, MAX_TAGS));
  const uploader = lengthOf(b, 'uploader');
  if (uploader > MAX_UPLOADER) invalid(tooLongExample('video:uploader', uploader, MAX_UPLOADER));
  for (const name of VIDEO_DEPRECATED) if (b.fields.has(name)) c.emitOnce('video-deprecated-field', b.line, `video:${name}`);
}

// Blocks checked when they close, keyed by namespace URI; `element` is the block element's local name.
const BLOCKS = new Map<string, BlockSpec>([
  [NEWS_NS, { element: 'news', fields: new Set<string>(NEWS_FIELDS), check: checkNews }],
  [VIDEO_NS, { element: 'video', fields: VIDEO_FIELDS, check: checkVideo }],
]);

/** "1,001 <image:image> elements (limit 1,000)": the English example value, plus code and params for the UI. */
export function tooManyExample(field: string, count: number, max: number): { value: string; code: ExampleCode; params: Params } {
  return {
    value: `${count.toLocaleString('en-US')} <${field}> elements (limit ${max.toLocaleString('en-US')})`,
    code: 'ext-too-many', params: { field, count, max },
  };
}

/** "<video:description> is 2,113 characters (limit 2,048)". */
export function tooLongExample(field: string, length: number, max: number): { value: string; code: ExampleCode; params: Params } {
  return {
    value: `<${field}> is ${length.toLocaleString('en-US')} characters (limit ${max.toLocaleString('en-US')})`,
    code: 'ext-too-long', params: { field, length, max },
  };
}

/** '<video:rating>: "7"'. The value is raw sitemap data; the validator caps it like every example. */
export function invalidValueExample(field: string, value: string): { value: string; code: ExampleCode; params: Params } {
  return { value: `<${field}>: "${value}"`, code: 'ext-invalid-value', params: { field, value } };
}

/**
 * Extension state of the <url> being parsed. The parser passes each element's local name with the namespace URI
 * bound to its prefix (undefined for unprefixed or unbound names), the text inside it, and collects the hits when
 * the <url> ends. A news or video block is checked once: when it closes, when its <url> ends, or when self-closed.
 */
export class ExtensionCollector {
  private hits: ExtensionDraft[] = [];
  private reported = new Set<string>();
  private block: (Block & { ns: string; spec: BlockSpec }) | null = null;
  private capture: { name: string; field: BlockField } | null = null;
  private blockCounts = new Map<string, number>(); // per block element across the sitemap; keys come from BLOCKS only
  private image: { line: number; hasLoc: boolean } | null = null; // the <image:image> being read
  private imageLoc: { line: number; text: string } | null = null;  // its <image:loc> text, capped like block fields

  /** now: the scan clock, for freshness rules. */
  constructor(readonly now = Date.now()) {}

  open(ns: string | undefined, local: string, line: number, selfClosing = false): void {
    if (ns === undefined) return;
    if (ns === IMAGE_NS && IMAGE_DEPRECATED.has(local)) this.emitOnce('image-deprecated-field', line, `image:${local}`);
    else if (ns === MOBILE_NS && local === 'mobile') this.emitOnce('mobile-obsolete', line);
    if (ns === IMAGE_NS) this.openImage(local, line, selfClosing);
    const block = this.block;
    if (block) {
      if (ns !== block.ns || !block.spec.fields.has(local)) return;
      let f = block.fields.get(local);
      if (!f) { f = { text: '', length: 0, count: 0 }; block.fields.set(local, f); }
      f.count++;
      if (f.count === 1 && !selfClosing) this.capture = { name: local, field: f }; // the first occurrence is the value
      return;
    }
    const spec = BLOCKS.get(ns);
    if (spec?.element !== local) return;
    this.blockCounts.set(local, (this.blockCounts.get(local) ?? 0) + 1);
    this.block = { ns, spec, line, fields: new Map() };
    if (selfClosing) this.closeBlock();
  }

  private openImage(local: string, line: number, selfClosing: boolean): void {
    if (local === 'image') {
      this.image = { line, hasLoc: false };
      this.imageLoc = null;
      if (selfClosing) this.closeImage();
    } else if (local === 'loc' && this.image) {
      this.image.hasLoc = true;
      this.imageLoc = { line, text: '' };
      if (selfClosing) this.closeImageLoc();
    }
  }

  private closeImageLoc(): void {
    const loc = this.imageLoc;
    this.imageLoc = null;
    if (!loc) return;
    const v = loc.text.trim();
    if (!isHttpUrl(v)) this.emit('invalid-extension-url', loc.line, invalidValueExample('image:loc', v));
  }

  private closeImage(): void {
    const image = this.image;
    this.image = null;
    this.imageLoc = null;
    if (image && !image.hasLoc) this.emit('invalid-extension-url', image.line, { value: '<image:image> has no <image:loc>', code: 'image-without-loc' });
  }

  text(s: string): void {
    const loc = this.imageLoc;
    if (loc && loc.text.length < MAX_EXT_VALUE) loc.text = (loc.text + s).slice(0, MAX_EXT_VALUE);
    const f = this.capture?.field;
    if (!f) return;
    f.length += s.length;
    if (f.text.length < MAX_EXT_VALUE) f.text = (f.text + s).slice(0, MAX_EXT_VALUE);
  }

  close(ns: string | undefined, local: string): void {
    if (ns === IMAGE_NS) {
      if (local === 'loc') this.closeImageLoc();
      else if (local === 'image') this.closeImage();
    }
    const block = this.block;
    if (!block) return;
    if (ns !== block.ns) return;
    if (this.capture?.name === local) this.capture = null;
    else if (local === block.spec.element) this.closeBlock();
  }

  /** Blocks of an element ('news', 'video') seen in the whole sitemap. */
  blockCount(element: string): number {
    return this.blockCounts.get(element) ?? 0;
  }

  emit(rule: ExtRuleId, line: number, example: ExtExample = {}): void {
    if (this.hits.length >= MAX_EXT_HITS_PER_URL) return;
    const hit: ExtensionDraft = { rule, line };
    if (example.value !== undefined) hit.value = capValue(example.value);
    if (example.code) hit.code = example.code;
    if (example.params) {
      const params: Params = {};
      for (const [k, v] of Object.entries(example.params)) params[k] = typeof v === 'string' ? capValue(v) : v;
      hit.params = params;
    }
    this.hits.push(hit);
  }

  /** Deprecated and obsolete tags count once per URL, however many images or videos carry them. */
  emitOnce(rule: ExtRuleId, line: number, value?: string): void {
    const key = `${rule} ${value ?? ''}`;
    if (this.reported.has(key)) return;
    if (this.reported.size < MAX_EXT_HITS_PER_URL) this.reported.add(key);
    this.emit(rule, line, value === undefined ? {} : { value });
  }

  /** Ends the current <url>: checks a block it left open, returns its hits in document order, resets the state. */
  endUrl(): ExtensionDraft[] {
    if (this.block) this.closeBlock();
    this.image = null;
    this.imageLoc = null;
    const out = this.hits;
    this.hits = [];
    this.reported.clear();
    return out;
  }

  private closeBlock(): void {
    const block = this.block;
    this.block = null;
    this.capture = null;
    if (block) block.spec.check(block, this);
  }
}
