import { fetchTextStream, type Transport } from './fetcher.js';
import { MAX_URL_CHARS } from './sitemap-limits.js';
import { normalizeSitemapUrl } from './url.js';
import type { FindingExample, RobotsGroup, RobotsInfo, RobotsRule } from './types.js';

const SITEMAP_LINE = /^\s*sitemap\s*:(.*)$/i;
const MAX_SITEMAPS = 500;
export const MAX_ROBOTS_CHARS = 512 * 1024; // decoded text read from robots.txt
const MAX_GROUPS = 500;
const MAX_RULES = 5000;              // across all groups
const MAX_RULE_PATH = 2048;

export function parseRobots(text: string, robotsUrl: string): { sitemapUrls: string[] } {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = SITEMAP_LINE.exec(line);
    if (!m?.[1]) continue;
    // a '#' only starts a comment after whitespace; one glued into the URL is a fragment
    const hash = /\s#/.exec(m[1]);
    const value = (hash ? m[1].slice(0, hash.index) : m[1]).trim();
    if (!value) continue;
    // Only accept absolute URLs or proper relative paths (starting with /)
    if (!/^(https?:|\/)/i.test(value)) continue;
    try {
      const u = normalizeSitemapUrl(new URL(value, robotsUrl).toString());
      if (u === null || u.length > MAX_URL_CHARS) continue;
      if (!out.includes(u)) out.push(u);
      if (out.length >= MAX_SITEMAPS) break;
    } catch { /* skip invalid */ }
  }
  return { sitemapUrls: out };
}

/** The product token of a User-agent value (RFC 9309 §2.2.1): lowercased, its leading letters, '_' and '-'; '*' for any crawler. */
export function productToken(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith('*')) return '*';
  let end = 0;
  while (end < v.length) {
    const c = v.charCodeAt(end);
    if (!((c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d)) break;
    end++;
  }
  return v.slice(0, end);
}

/**
 * Crawler access groups (RFC 9309 §2.1–2.2): consecutive User-agent lines open a group, Allow / Disallow lines fill it,
 * and the next User-agent line after a rule opens another. Other keys are skipped without ending the group. Anything
 * past the caps is dropped, never shortened: a shortened Disallow path would block more.
 */
export function parseRobotsGroups(text: string): { groups: RobotsGroup[]; capped: boolean } {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inAgents = false; // the last group line was a User-agent line
  let rules = 0;
  let capped = false;
  for (const [i, raw] of text.split(/\r\n|\r|\n/).entries()) {
    const hash = raw.indexOf('#');
    const line = hash === -1 ? raw : raw.slice(0, hash);
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!inAgents) {
        if (groups.length >= MAX_GROUPS) { capped = true; current = null; }
        else { current = { agents: [], rules: [] }; groups.push(current); }
      }
      inAgents = true;
      const token = productToken(value);
      if (current && token) current.agents.push(token);
    } else if (key === 'allow' || key === 'disallow') {
      inAgents = false;
      if (!current || !value) continue; // before any User-agent line, in a dropped group, or empty (RFC 9309 §2.2.2)
      if (value.length > MAX_RULE_PATH || rules >= MAX_RULES) { capped = true; continue; }
      current.rules.push({ allow: key === 'allow', path: value, line: i + 1 });
      rules++;
    }
  }
  return { groups, capped };
}

/**
 * How a validation run may use its robots.txt: 2xx → its rules; other statuses below 500 except 429 → nothing is
 * blocked; 5xx, 429 or a failed fetch (null) → unverified, never blocked. A RobotsInfo without a status (or without
 * groups) is legacy data from an older shape: no robots findings at all.
 */
export type RobotsMode = 'rules' | 'allow-all' | 'unverified' | 'legacy';

export function robotsMode(robots: RobotsInfo | null): RobotsMode {
  if (!robots) return 'unverified';
  if (robots.status === undefined) return 'legacy';
  if (robots.found) return robots.groups ? 'rules' : 'legacy';
  return robots.status === 429 || robots.status >= 500 ? 'unverified' : 'allow-all';
}

/** signal: the caller's, so a cancelled or timed-out run stops reading robots.txt; the fetch itself is capped at 15 s idle and 30 s in all. */
export async function fetchRobots(origin: string, opts: { signal?: AbortSignal | undefined; transport?: Transport | undefined } = {}): Promise<RobotsInfo | null> {
  const url = `${origin}/robots.txt`;
  let text = '';
  let status: number;
  let cut = false;
  let reader: ReadableStreamDefaultReader<string> | undefined;
  try {
    const r = await fetchTextStream(url, { timeoutMs: 15_000, totalMs: 30_000, signal: opts.signal, transport: opts.transport });
    status = r.status;
    if (!r.ok || !r.stream) return { found: false, url, status, sitemapUrls: [] };
    reader = r.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
      if (text.length > MAX_ROBOTS_CHARS) { cut = true; break; } // a body of exactly the cap is read whole
    }
  } catch { return null; } finally {
    void reader?.cancel().catch(() => { /* best-effort; the stream is already abandoned */ });
  }
  if (cut) {
    // the cap can fall inside a line; a cut "Disallow: /admin-area" would read as "/a" and block far more
    text = text.slice(0, MAX_ROBOTS_CHARS);
    text = text.slice(0, Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1);
  }
  const { groups, capped } = parseRobotsGroups(text);
  const info: RobotsInfo = { found: true, url, status, sitemapUrls: parseRobots(text, url).sitemapUrls, groups };
  if (capped || cut) info.capped = true;
  return info;
}

const MAX_MATCH_PATH = 8192;                    // longer paths are not checked (over-limit)
export const MATCH_STEP_BUDGET = 300_000_000;   // steps per meter, then over-limit: about 0.7-1.8 s of work in all (measured 2.3-6 ms per million); a caller can spread that over several meters or calls to keep each slice short
const RULE_STEP_COST = 4;                       // steps charged for examining one rule, whatever it compares
const SKIP_STEP_COST = 1;                       // steps charged for a rule the length / character prefilter rules out
const CALL_STEP_COST = 64;                      // steps charged for one match call on top of its path length
const MAX_COMPILED_PARTS = 50_000;              // '*'-separated parts across one compiled set; past it every match is over-limit

const HEX = '0123456789ABCDEF';
const utf8 = new TextEncoder();
const pct = (b: number): string => '%' + HEX.charAt(b >> 4) + HEX.charAt(b & 15);
function hexValue(b: number | undefined): number {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}
// RFC 3986 §2.3
const isUnreserved = (b: number): boolean =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
// ASCII the WHATWG URL parser percent-encodes in a path or a query (" ' < > ` { } ^ |, depending on the part and the
// engine): escaped on both sides here, so a rule and a URL agree whichever way a parser wrote them.
const isEscapedAscii = (b: number): boolean => b <= 0x20 || b >= 0x7f || '"\'<>`{}^|'.includes(String.fromCharCode(b));

/**
 * One form for rule paths and URL paths (RFC 9309 §2.2.2): UTF-8 bytes; escapes get uppercase hex and are decoded only
 * for unreserved characters; a stray '%' becomes %25; controls, space, DEL, non-ASCII bytes and the ASCII characters URL
 * parsers escape are written as %XX. '*' and '$' stay as they are, so the matcher still sees them; their escapes %2A /
 * %24 stay escaped and match only themselves.
 */
export function normalizeRobotsPath(s: string): string {
  const bytes = utf8.encode(s); // lone surrogates become U+FFFD instead of throwing
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0x25) {
      const hi = hexValue(bytes[i + 1]);
      const lo = hexValue(bytes[i + 2]);
      if (hi < 0 || lo < 0) { out += '%25'; continue; }
      const v = hi * 16 + lo;
      out += isUnreserved(v) ? String.fromCharCode(v) : pct(v);
      i += 2;
    } else out += isEscapedAscii(b) ? pct(b) : String.fromCharCode(b);
  }
  return out;
}

/** The part of a URL that robots.txt rules match (path and query), or null when the URL is not http(s) on exactly this origin or one of the given alias origins. */
export function robotsPathOf(loc: string | URL, origin: string, aliases?: readonly string[]): string | null {
  let u: URL;
  try { u = typeof loc === 'string' ? new URL(loc) : loc; } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || (u.origin !== origin && aliases?.includes(u.origin) !== true)) return null;
  return u.pathname + u.search;
}

/** The rules a crawler obeys: every group naming its product token, merged; only if none does, every '*' group. */
function selectRules(groups: readonly RobotsGroup[], agent: string): RobotsRule[] {
  const token = productToken(agent);
  const pick = groups.some((g) => g.agents.includes(token)) ? token : '*';
  return groups.filter((g) => g.agents.includes(pick)).flatMap((g) => g.rules);
}

// A literal run between stars. Its KMP failure table lives in the compiled set's shared array at [off, off + text.length); parts of one character need none (off = -1).
interface Part { text: string; off: number }
/** A rule ready to match: its normalized pattern cut at '*' into a literal first part, middle parts and a last part. */
interface CompiledRule {
  rule: RobotsRule;
  specificity: number;   // normalized pattern length, '*' and '$' included
  anchored: boolean;     // the pattern ended with '$'
  first: string;
  middle: Part[];
  last: Part | null;     // null when the pattern has no '*'
  minLength: number;     // the literal parts' total length: no shorter path can match
  maskLo: number;        // characters the literal parts need, one bit per charCode % 64 (low 32 bits)
  maskHi: number;        // and the high 32 bits: a path missing one of them cannot match
}
/** The rules one crawler obeys, bucketed by the pattern's second character. Immutable and shareable; the work meter is the caller's. */
export interface CompiledRobots { byKey: Map<string, CompiledRule[]>; wild: CompiledRule[]; tables: Int32Array; overLimit: boolean }

/**
 * A caller-owned work meter for matchRobots. One meter per pass: a run uses one per sitemap file, and a caller
 * filtering rows again starts a new one. Once steps pass MATCH_STEP_BUDGET every match on it answers over-limit.
 */
export interface MatchMeter { steps: number }

// KMP failure table written into out[off, off + text.length): out[off + i] = length of the longest proper prefix of text[0..i] that is also its suffix.
function fillFailureTable(text: string, out: Int32Array, off: number): void {
  let k = 0;
  for (let i = 1; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) k = out[off + k - 1] ?? 0;
    if (text.charCodeAt(i) === text.charCodeAt(k)) k++;
    out[off + i] = k;
  }
}

const countStars = (pattern: string): number => {
  let n = 0;
  for (let i = pattern.indexOf('*'); i !== -1; i = pattern.indexOf('*', i + 1)) n++;
  return n;
};

// One bit per charCode % 64 in a pair of 32-bit ints (a lower- and an upper-case letter share nothing, but 'a' and '!' do: a collision only lets a rule through to the full match).
function addToMask(mask: [number, number], text: string): void {
  for (let i = 0; i < text.length; i++) {
    const bit = text.charCodeAt(i) & 63;
    if (bit < 32) mask[0] |= 1 << bit; else mask[1] |= 1 << (bit - 32);
  }
}

interface RuleDraft { rule: RobotsRule; pattern: string; anchored: boolean; texts: string[] }

function draftRule(rule: RobotsRule, pattern: string): RuleDraft {
  const anchored = pattern.endsWith('$');
  return { rule, pattern, anchored, texts: (anchored ? pattern.slice(0, -1) : pattern).split('*') };
}

// Paths start with '/', so a rule whose literal start is "/x…" can only match paths whose second character is x.
const bucketKey = (c: CompiledRule): string | null => (c.first.length >= 2 && c.first.startsWith('/') ? c.first.charAt(1) : null);
// A pattern that starts with neither '/' nor '*' can never match a path.
const canMatch = (c: CompiledRule): boolean => c.first === '' || c.first.startsWith('/');
// Most specific first, Allow before Disallow on a tie: the first rule that matches decides (RFC 9309 §2.2.2).
const byPrecedence = (a: CompiledRule, b: CompiledRule): number => b.specificity - a.specificity || Number(b.rule.allow) - Number(a.rule.allow);

const compiled = new WeakMap<readonly RobotsGroup[], Map<string, CompiledRobots>>();

function compile(rules: readonly RobotsRule[]): CompiledRobots {
  const drafts: RuleDraft[] = [];
  let parts = 0;
  for (const rule of rules) {
    const pattern = normalizeRobotsPath(rule.path);
    parts += countStars(pattern) + 1;
    if (parts > MAX_COMPILED_PARTS) return { byKey: new Map(), wild: [], tables: new Int32Array(0), overLimit: true };
    drafts.push(draftRule(rule, pattern));
  }
  // KMP only searches middle parts and a non-anchored last part; the first part is a prefix check and an anchored last part a suffix check
  const searched = (d: RuleDraft): string[] => (d.texts.length < 2 ? [] : d.texts.slice(1, d.anchored ? -1 : undefined));
  let tableLength = 0;
  for (const d of drafts) for (const text of searched(d)) if (text.length >= 2) tableLength += text.length;
  const tables = new Int32Array(tableLength);
  let next = 0;
  const part = (text: string): Part => {
    if (text.length < 2) return { text, off: -1 };
    const off = next;
    fillFailureTable(text, tables, off);
    next += text.length;
    return { text, off };
  };
  const unsearched = (text: string): Part => ({ text, off: -1 });
  const all: CompiledRule[] = drafts.map((d) => {
    const texts = [...d.texts];
    const first = texts.shift() ?? '';
    const lastText = texts.pop();
    const mask: [number, number] = [0, 0];
    let minLength = first.length;
    addToMask(mask, first);
    for (const text of texts) { minLength += text.length; addToMask(mask, text); }
    if (lastText !== undefined) { minLength += lastText.length; addToMask(mask, lastText); }
    return {
      rule: d.rule, specificity: d.pattern.length, anchored: d.anchored, first,
      // consecutive '*' leave empty middle parts: they match anywhere and would only cost time
      middle: texts.filter((t) => t !== '').map(part), last: lastText === undefined ? null : d.anchored ? unsearched(lastText) : part(lastText),
      minLength, maskLo: mask[0], maskHi: mask[1],
    };
  }).filter(canMatch);
  const wild = all.filter((c) => bucketKey(c) === null);
  const byKey = new Map<string, CompiledRule[]>();
  for (const c of all) {
    const key = bucketKey(c);
    if (key === null) continue;
    const list = byKey.get(key);
    if (list) list.push(c); else byKey.set(key, [c]);
  }
  for (const [key, list] of byKey) byKey.set(key, [...list, ...wild].sort(byPrecedence));
  wild.sort(byPrecedence);
  return { byKey, wild, tables, overLimit: false };
}

/** Compiles the rules for one crawler once per groups array (RobotsInfo.groups) and product token. */
export function compileRobots(groups: readonly RobotsGroup[], agent: string): CompiledRobots {
  const token = productToken(agent);
  let perAgent = compiled.get(groups);
  if (!perAgent) { perAgent = new Map(); compiled.set(groups, perAgent); }
  const cached = perAgent.get(token);
  if (cached) return cached;
  const result = compile(selectRules(groups, token));
  perAgent.set(token, result);
  return result;
}

// Leftmost start of part.text inside s[from, end), or -1. KMP: O(end - from + |text|), no backtracking over s; every
// character comparison, including the ones that follow a failure link, is one step.
function findPart(part: Part, tables: Int32Array, s: string, from: number, end: number, m: MatchMeter): number {
  const { text, off } = part;
  if (text.length === 0) { m.steps++; return from; }
  let k = 0;
  for (let i = from; i < end; i++) {
    const ch = s.charCodeAt(i);
    while (k > 0 && ch !== text.charCodeAt(k)) { k = tables[off + k - 1] ?? 0; m.steps++; }
    if (ch === text.charCodeAt(k)) k++;
    m.steps++;
    if (k === text.length) return i - k + 1;
  }
  return -1;
}

// Prefix / suffix checks that charge only the characters they compare (at least 1).
function hasPrefix(s: string, prefix: string, m: MatchMeter): boolean {
  if (prefix.length > s.length) { m.steps++; return false; }
  for (let i = 0; i < prefix.length; i++) {
    if (s.charCodeAt(i) !== prefix.charCodeAt(i)) { m.steps += i + 1; return false; }
  }
  m.steps += Math.max(prefix.length, 1);
  return true;
}
function hasSuffix(s: string, suffix: string, m: MatchMeter): boolean {
  if (suffix.length > s.length) { m.steps++; return false; }
  const offset = s.length - suffix.length;
  for (let i = suffix.length - 1; i >= 0; i--) {
    if (s.charCodeAt(offset + i) !== suffix.charCodeAt(i)) { m.steps += suffix.length - i; return false; }
  }
  m.steps += Math.max(suffix.length, 1);
  return true;
}

// Greedy leftmost placement of the parts is exact for '*'-only patterns. Each search starts where the previous part
// ended, so the scanned ranges are disjoint: at most about 2 × |s| comparisons per rule.
function ruleMatches(r: CompiledRule, tables: Int32Array, s: string, m: MatchMeter): boolean {
  m.steps += RULE_STEP_COST;
  if (!hasPrefix(s, r.first, m)) return false;
  if (!r.last) return !r.anchored || s.length === r.first.length;
  const end = r.anchored ? s.length - r.last.text.length : s.length;
  let pos = r.first.length;
  if (end < pos) return false;
  for (const p of r.middle) {
    const at = findPart(p, tables, s, pos, end, m);
    if (at < 0) return false;
    pos = at + p.text.length;
  }
  if (r.anchored) return hasSuffix(s, r.last.text, m);
  return findPart(r.last, tables, s, pos, s.length, m) >= 0;
}

export type RobotsVerdict = { kind: 'allowed'; rule?: RobotsRule } | { kind: 'blocked'; rule: RobotsRule } | { kind: 'over-limit' };

/**
 * Whether the crawler may fetch a path (a robotsPathOf result). The deciding rule comes back with the verdict; no
 * matching rule means allowed. Once the meter has spent MATCH_STEP_BUDGET (checked before every rule), or for a path
 * over MAX_MATCH_PATH, or for a compiled set past MAX_COMPILED_PARTS, the answer is over-limit: the caller counts the URL as not checked.
 */
export function matchRobots(c: CompiledRobots, path: string, meter: MatchMeter): RobotsVerdict {
  if (c.overLimit || meter.steps > MATCH_STEP_BUDGET || path.length > MAX_MATCH_PATH) return { kind: 'over-limit' };
  const s = normalizeRobotsPath(path);
  meter.steps += 2 * s.length + CALL_STEP_COST; // the normalized path once more for its character mask
  if (s === '/robots.txt') return { kind: 'allowed' }; // RFC 9309 §2.2.2
  const pathMask: [number, number] = [0, 0];
  addToMask(pathMask, s);
  const notLo = ~pathMask[0];
  const notHi = ~pathMask[1];
  for (const r of c.byKey.get(s.charAt(1)) ?? c.wild) {
    if (meter.steps > MATCH_STEP_BUDGET) return { kind: 'over-limit' };
    // a rule that needs a longer path or a character the path lacks cannot match: skip it for one step
    if (s.length < r.minLength || (r.maskLo & notLo) !== 0 || (r.maskHi & notHi) !== 0) { meter.steps += SKIP_STEP_COST; continue; }
    if (ruleMatches(r, c.tables, s, meter)) return r.rule.allow ? { kind: 'allowed', rule: r.rule } : { kind: 'blocked', rule: r.rule };
  }
  return { kind: 'allowed' };
}

// English example texts, reported as FindingExample.value; callers that localize findings can key their own text by code.
const UNCHECKED = {
  'robots-other-origin': 'on another origin than robots.txt',
  'robots-unreachable': 'robots.txt could not be read',
  'robots-check-limit': 'not checked, the robots.txt check reached its limit',
} as const;
type UncheckedCode = keyof typeof UNCHECKED;

/** Example for a URL the crawler may not fetch: the URL, the deciding rule and its robots.txt line (a string param, so it renders without a thousands separator). */
export function blockedExample(url: string, rule: RobotsRule): FindingExample {
  const text = `${rule.allow ? 'Allow' : 'Disallow'}: ${rule.path}`;
  return { value: `${url}: blocked by "${text}" (robots.txt line ${rule.line})`, code: 'robots-rule', params: { url, rule: text, robotsLine: String(rule.line) } };
}

/** Example for a URL that was not checked, with the reason as its code. */
export function uncheckedExample(code: UncheckedCode, url: string): FindingExample {
  return { value: `${url}: ${UNCHECKED[code]}`, code, params: { url } };
}
