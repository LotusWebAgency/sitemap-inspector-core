import type { LayoutSink } from './printer.js';
import type { ExampleCode, Params } from './types.js';
import { cut } from './text.js';

export type XmlToken =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean; line: number }
  | { type: 'close'; name: string; line: number }
  | { type: 'text'; text: string; line: number }
  | { type: 'xmldecl'; encoding: string; line: number }
  | { type: 'error'; message: string; code: ExampleCode; params: Params; line: number };

const LT = 60, GT = 62, EQ = 61, BANG = 33, DASH = 45, QMARK = 63, DQUOTE = 34, SQUOTE = 39, LBRACKET = 91, RBRACKET = 93;
const DOT = 46, COLON = 58, UNDERSCORE = 95;

const NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
// A reference is at most this long, '&' and ';' included. decodeEntities refuses longer ones in every path, and the
// text hold-back at a chunk end waits for this many characters, so decoding never depends on where chunks split.
const MAX_REF_LEN = 24;
const ENTITY_RE = new RegExp(`&(#[0-9]{1,${MAX_REF_LEN - 3}}|#[xX][0-9a-fA-F]{1,${MAX_REF_LEN - 4}}|[a-zA-Z]{1,${MAX_REF_LEN - 2}});`, 'g');

// XML 1.0 Char production: tab, LF, CR, U+0020..U+D7FF, U+E000..U+FFFD, U+10000..U+10FFFF
// (so &#0;, &#xFFFE;, &#xFFFF;, surrogates, other C0 controls and anything past U+10FFFF stay literal).
const isXmlChar = (c: number) => c === 9 || c === 10 || c === 13
  || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);

// `decoded` counts the entities actually replaced, so bare-ampersand counting agrees with decoding.
function decodeCounting(s: string): [string, number] {
  let decoded = 0;
  const text = s.replace(ENTITY_RE, (m, e: string) => {
    let r: string | undefined;
    if (e.startsWith('#')) {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (isXmlChar(code)) r = String.fromCodePoint(code);
    } else r = NAMED.get(e);
    if (r === undefined) return m;
    decoded++;
    return r;
  });
  return [text, decoded];
}

export function decodeEntities(s: string): string {
  return !s.includes('&') ? s : decodeCounting(s)[0];
}

function countAmps(s: string): number {
  let n = 0;
  for (let i = s.indexOf('&'); i !== -1; i = s.indexOf('&', i + 1)) n++;
  return n;
}

const isNameChar = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)
  || c === UNDERSCORE || c === COLON || c === DOT || c === DASH;

// Exactly the characters of the regex class \s (and of String.prototype.trim): JS whitespace and line terminators.
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

// Same as /^[\w:.-]+$/ (\w is ASCII only).
function isName(s: string): boolean {
  const n = s.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (!isNameChar(s.charCodeAt(i))) return false;
  return true;
}

// Attribute maps have no prototype: a name such as __proto__ or constructor is an ordinary own key, never an inherited member.
const noAttrs = (): Record<string, string> => Object.create(null) as Record<string, string>;

// Linear single pass: name, '=', quoted value; anything else is skipped. `seen` collects what makes the tag
// malformed XML: a bare '&' in a value counts like one in text, a raw '<' in a value is an error.
function parseAttrs(s: string, seen: { bare: number; lt: boolean }): Record<string, string> {
  const attrs = noAttrs();
  const n = s.length;
  let p = 0;
  while (p < n) {
    if (!isNameChar(s.charCodeAt(p))) { p++; continue; }
    const nameStart = p;
    while (p < n && isNameChar(s.charCodeAt(p))) p++;
    const name = s.slice(nameStart, p);
    while (p < n && s.charCodeAt(p) <= 32) p++;
    if (s[p] !== '=') continue;
    p++;
    while (p < n && s.charCodeAt(p) <= 32) p++;
    const q = s[p];
    if (q !== '"' && q !== "'") continue;
    const close = s.indexOf(q, p + 1);
    if (close === -1) break;
    const raw = s.slice(p + 1, close);
    let value = raw;
    if (raw.includes('&')) {
      const [decodedValue, decoded] = decodeCounting(raw);
      seen.bare += countAmps(raw) - decoded;
      value = decodedValue;
    }
    if (raw.includes('<')) seen.lt = true;
    attrs[name] = value;
    p = close + 1;
  }
  return attrs;
}

const MAX_TAG = 65536; // resync guard: a "tag" (or comment/PI/DOCTYPE) longer than this is treated as garbage
const MAX_CDATA = 1 << 20;
const MAX_TEXT_RUN = 65536; // keep-first cap on one accumulated text run; the parser caps per field again
const MAX_ENCODING = 64;
const XML_DECL = /^xml[\s?]/;
const DECL_ENCODING = /\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/;

// Where a DOCTYPE with an internal subset really ends: the '>' outside quotes and outside [ ... ]. Comments and
// processing instructions inside the subset are skipped whole, so an apostrophe in one cannot open a quote.
// The scan is streamed (no buffering), so it behaves the same at any chunk size.
interface Doctype { line: number; size: number; done: boolean; over: boolean; quote: number; sub: boolean; mode: 0 | 1 | 2; c1: number; c2: number; c3: number }

export class XmlTokenizer {
  private buf = '';
  private bare = 0;
  private emitted = false; // a token left a previous write(): the XML declaration can only come first
  private dtd: Doctype | null = null;
  private pendingText: string | null = null;
  private pendingFull = false; // the run reached MAX_TEXT_RUN, even when a surrogate-safe cut kept fewer
  private pendingTextLine = 0; // the run's first content line, 0 before one
  // scan state of the incomplete construct at the start of `buf`, so a re-scan after the next
  // write() resumes where it stopped instead of starting over (a slow-fed huge tag stays linear)
  private resumeAt = 0;
  private tagQuote = 0;
  private tagEq = false;
  private strayAt = 0;
  // An open comment, PI, declaration or CDATA section that can still grow arrives as parts: a chunk that cannot
  // complete it is appended without joining the buffer, so each chunk costs its own length, not the construct's.
  private held: string[] = [];
  private heldLen = 0;
  private heldTerm = '';
  private heldMax = 0;
  private heldTail = '';
  // terminator of an oversized construct being discarded without buffering
  private skip: string | null = null;
  // markup past the cap with no '<' after it yet: everything up to the next '<' still belongs to it, whatever the chunking
  private garbage = false;

  // Every consumed span of input goes to the sink exactly once, in order; the sink's returns are the tokens' lines.
  constructor(private readonly sink: LayoutSink) {}

  get bareAmpersands() { return this.bare; }

  // Streams a DOCTYPE body from buf[i] on; returns where it stopped (n, or just past the closing '>').
  private skipDoctype(buf: string, i: number, n: number): number {
    const d = this.dtd;
    if (!d) return i;
    let { quote, sub, mode, c1, c2, c3 } = d;
    let j = i;
    let done = false;
    // Until the cap is passed: consume at most one char past it, whatever the chunking. After the error (`over`) the rest is
    // discarded in the same scan, so it ends at the declaration's real '>' and not at one inside the subset.
    const lim = d.over ? n : Math.min(n, i + MAX_TAG + 1 - d.size);
    for (; j < lim; j++) {
      const c = buf.charCodeAt(j);
      if (mode === 1) {
        if (c === GT && c1 === DASH && c2 === DASH) mode = 0;
      } else if (mode === 2) {
        if (c === GT && c1 === QMARK) mode = 0;
      } else if (quote) {
        if (c === quote) quote = 0;
      } else if (c === DQUOTE || c === SQUOTE) quote = c;
      else if (sub) {
        if (c === DASH && c1 === DASH && c2 === BANG && c3 === LT) mode = 1; // <!--
        else if (c === QMARK && c1 === LT) mode = 2; // <?
        else if (c === RBRACKET) sub = false;
      } else if (c === LBRACKET) sub = true;
      else if (c === GT) { done = true; j++; break; }
      c3 = c2; c2 = c1; c1 = c;
    }
    Object.assign(d, { quote, sub, mode, c1, c2, c3, done });
    d.size += j - i;
    this.sink.span('doctype', buf.slice(i, j), !done);
    return j;
  }

  // Index of the '>' closing the tag at buf[i]; -1 need more data; -2 a stray '<' (at strayAt)
  // outside any quoted value; -3 longer than MAX_TAG. Quotes only open right after '=', so a
  // lone apostrophe in garbage can't swallow the rest of the document, and '>' inside a value is kept.
  private scanTag(buf: string, i: number, rs: number, rq: number, req: boolean): number {
    const n = buf.length;
    const lim = Math.min(n, i + MAX_TAG + 1);
    let p = rs ? i + rs : i + 1;
    let q = rs ? rq : 0;
    let eq = rs ? req : false;
    for (; p < lim; p++) {
      const c = buf.charCodeAt(p);
      if (q) { // inside a quoted value: jump to its closing quote, or to the end of what can be scanned
        const e = buf.indexOf(q === DQUOTE ? '"' : "'", p);
        if (e === -1 || e >= lim) { p = lim; break; }
        q = 0; p = e; continue;
      }
      if (c === GT) return p;
      if (c === LT) { this.strayAt = p; return -2; }
      if (c === DQUOTE || c === SQUOTE) { if (eq) q = c; eq = false; } else if (c === EQ) eq = true; else if (c > 32) eq = false;
    }
    if (n - i > MAX_TAG) return -3;
    this.resumeAt = p - i; this.tagQuote = q; this.tagEq = eq;
    return -1;
  }

  private joinHeld() {
    if (!this.heldTerm) return;
    this.buf = this.held.join('');
    this.held = [];
    this.heldTerm = '';
    this.heldTail = '';
  }

  write(chunk: string): XmlToken[] {
    if (this.heldTerm) {
      if (!chunk) return [];
      const probe = this.heldTail + chunk;
      if (this.heldLen + chunk.length <= this.heldMax && !probe.includes(this.heldTerm)) {
        this.held.push(chunk);
        this.heldLen += chunk.length;
        this.heldTail = probe.slice(probe.length - (this.heldTerm.length - 1));
        this.resumeAt = Math.max(0, this.heldLen - this.heldTerm.length + 1);
        return [];
      }
      this.joinHeld();
    }
    this.buf += chunk;
    const out: XmlToken[] = [];
    const buf = this.buf;
    const n = buf.length;
    let i = 0;
    const rs = this.resumeAt, rq = this.tagQuote, req = this.tagEq;
    this.resumeAt = 0; this.tagQuote = 0; this.tagEq = false;

    const flushPendingText = () => {
      if (this.pendingText === null) return;
      if (this.pendingText.trim()) out.push({ type: 'text', text: this.pendingText, line: this.pendingTextLine });
      this.pendingText = null;
    };

    let holdTerm = '', holdMax = 0;

    // End of `term` for the construct at i: -1 = need more data, -2 = over `max` (caller discards it)
    const findEnd = (term: string, openLen: number, max: number): number => {
      const e = buf.indexOf(term, i + Math.max(openLen, i === 0 ? rs : 0));
      if (e !== -1 && e - i <= max) return e;
      if (e !== -1 || n - i > max) return -2;
      this.resumeAt = Math.max(0, n - i - term.length + 1);
      if (i === 0) { holdTerm = term; holdMax = max; }
      return -1;
    };
    const discard = (term: string, openLen: number, code: ExampleCode, what: string) => {
      const line = this.sink.span('bad', buf.slice(i, i + openLen), true);
      out.push({ type: 'error', message: `${what} is unterminated or too long, skipping it`, code, params: {}, line });
      this.skip = term; i += openLen;
    };

    while (i < n) {
      if (this.skip) {
        const e = buf.indexOf(this.skip, i);
        if (e === -1) {
          const keep = Math.max(i, n - this.skip.length + 1);
          this.sink.span('bad', buf.slice(i, keep), true); i = keep; break;
        }
        this.sink.span('bad', buf.slice(i, e + this.skip.length)); i = e + this.skip.length; this.skip = null;
        continue;
      }
      if (this.garbage) {
        const lt = buf.indexOf('<', i);
        if (lt === -1) { this.sink.span('bad', buf.slice(i), true); i = n; break; }
        this.sink.span('bad', buf.slice(i, lt)); this.garbage = false; i = lt;
        continue;
      }
      if (this.dtd) {
        const d = this.dtd;
        i = this.skipDoctype(buf, i, n);
        if (d.done) this.dtd = null;
        else if (!d.over && d.size > MAX_TAG) { // same guard as every other construct: report it once, then discard the rest
          out.push({
            type: 'error', message: 'declaration is unterminated or too long, skipping it', code: 'unterminated-declaration', params: {}, line: d.line,
          });
          d.over = true;
        }
        if (i >= n) break;
        continue;
      }
      if (buf[i] === '<') {
        flushPendingText(); // a literal '<' always ends any text run in progress
        if (buf.startsWith('<!--', i)) {
          const end = findEnd('-->', 4, MAX_TAG);
          if (end === -1) break;
          if (end === -2) { discard('-->', 4, 'unterminated-comment', 'comment'); continue; }
          this.sink.span('comment', buf.slice(i, end + 3)); i = end + 3; continue;
        }
        if (buf.startsWith('<![CDATA[', i)) {
          const end = findEnd(']]>', 9, MAX_CDATA);
          if (end === -1) break;
          if (end === -2) { discard(']]>', 9, 'unterminated-cdata', 'CDATA section'); continue; }
          const line = this.sink.span('cdata', buf.slice(i, end + 3));
          out.push({ type: 'text', text: buf.slice(i + 9, end), line });
          i = end + 3; continue;
        }
        // possibly-incomplete '<!--' / '<![CDATA[' prefix at buffer end: wait for more data
        if (n - i < 9 && (
          '<!--'.startsWith(buf.slice(i, Math.min(i + 4, n))) || '<![CDATA['.startsWith(buf.slice(i, n)) || '<!DOCTYPE'.startsWith(buf.slice(i, n))
        )) break;
        if (buf.startsWith('<!DOCTYPE', i)) {
          const line = this.sink.span('doctype', buf.slice(i, i + 9), true);
          this.dtd = { line, size: 9, done: false, over: false, quote: 0, sub: false, mode: 0, c1: 0, c2: 0, c3: 0 };
          i += 9; continue;
        }
        if (buf.startsWith('<?', i) || buf.startsWith('<!', i)) {
          const end = findEnd('>', 2, MAX_TAG);
          if (end === -1) break;
          if (end === -2) {
            if (buf[i + 1] === '?') discard('>', 2, 'unterminated-pi', 'processing instruction');
            else discard('>', 2, 'unterminated-declaration', 'declaration');
            continue;
          }
          const decl = buf[i + 1] === '?' && XML_DECL.test(buf.slice(i + 2, i + 8));
          const line = this.sink.span(decl ? 'decl' : 'pi', buf.slice(i, end + 1));
          if (decl && !this.emitted && out.length === 0) {
            const m = DECL_ENCODING.exec(buf.slice(i + 5, Math.min(end, i + 5 + 256)));
            if (m) out.push({ type: 'xmldecl', encoding: cut(m[1] ?? m[2] ?? '', MAX_ENCODING), line });
          }
          i = end + 1; continue;
        }
        const end = this.scanTag(buf, i, i === 0 ? rs : 0, rq, req);
        if (end === -1) break;
        if (end < 0) { // garbage guard: report and resync at the next '<'
          const next = end === -2 ? this.strayAt : buf.indexOf('<', i + 1);
          const line = this.sink.span('bad', buf.slice(i, next === -1 ? n : next), next === -1);
          out.push(end === -2
            ? { type: 'error', message: 'unterminated markup', code: 'unterminated-markup', params: {}, line }
            : {
              type: 'error', message: `markup longer than ${MAX_TAG.toLocaleString('en-US')} characters`,
              code: 'markup-too-long', params: { max: MAX_TAG }, line,
            });
          if (next === -1) { this.garbage = true; i = n; break; }
          i = next; continue;
        }
        const raw = buf.slice(i + 1, end);
        const tag = buf.slice(i, end + 1);
        i = end + 1;
        if (raw.startsWith('/')) {
          const startLine = this.sink.span('close', tag);
          let name = raw.slice(1);
          if (!isName(name)) name = name.trim();
          if (isName(name)) out.push({ type: 'close', name, line: startLine });
          else {
            out.push({
              type: 'error', message: `malformed closing tag </${cut(raw.slice(1), 64)}>`, code: 'malformed-close-tag',
              params: { tag: cut(raw.slice(1), 64) }, line: startLine,
            });
          }
        } else {
          const selfClosing = raw.endsWith('/');
          const body = selfClosing ? raw.slice(0, -1) : raw;
          const bodyLen = body.length;
          let nameEnd = 0;
          while (nameEnd < bodyLen && isNameChar(body.charCodeAt(nameEnd))) nameEnd++;
          // the name ends at the first whitespace (or the end of the tag); anything else in between makes it malformed
          const sp = nameEnd === bodyLen ? -1 : nameEnd;
          const name = sp === -1 ? body : body.slice(0, sp);
          if (nameEnd > 0 && (sp === -1 || isSpace(body.charCodeAt(sp)))) {
            const startLine = this.sink.span(selfClosing ? 'self' : 'open', tag);
            const seen = { bare: 0, lt: false };
            const attrs = sp === -1 ? noAttrs() : parseAttrs(body.slice(sp), seen);
            this.bare += seen.bare;
            if (seen.lt) {
              out.push({
                type: 'error', message: `malformed tag <${cut(raw, 64)}>`, code: 'malformed-tag', params: { tag: cut(raw, 64) }, line: startLine,
              });
            }
            out.push({ type: 'open', name, attrs, selfClosing, line: startLine });
          } else {
            const startLine = this.sink.span('bad', tag);
            out.push({
              type: 'error', message: `malformed tag <${cut(raw, 64)}>`, code: 'malformed-tag', params: { tag: cut(raw, 64) }, line: startLine,
            });
          }
        }
        continue;
      }
      // text run until next '<'
      const lt = buf.indexOf('<', i);
      let sliceEnd = lt === -1 ? n : lt;
      if (lt === -1) {
        // hold back a possibly-split trailing reference: one that still fits MAX_REF_LEN once its ';' arrives
        const amp = buf.lastIndexOf('&');
        if (amp >= i && amp > n - MAX_REF_LEN && !buf.includes(';', amp)) sliceEnd = amp;
      }
      const raw = buf.slice(i, sliceEnd);
      if (raw) {
        if (this.pendingText === null) { this.pendingText = ''; this.pendingTextLine = 0; this.pendingFull = false; }
        this.pendingTextLine = this.sink.span('text', raw);
        if (!this.emitted && out.length === 0 && raw.trim()) this.emitted = true;
        let text = raw;
        if (raw.includes('&')) {
          const [decodedText, decoded] = decodeCounting(raw);
          this.bare += countAmps(raw) - decoded;
          text = decodedText;
        }
        if (!this.pendingFull) {
          const run = this.pendingText + text;
          this.pendingFull = run.length >= MAX_TEXT_RUN;
          this.pendingText = cut(run, MAX_TEXT_RUN);
        }
      }
      i = sliceEnd;
      if (lt === -1) break; // no more markup found yet; keep pendingText buffered across write() calls
    }
    this.buf = buf.slice(i);
    if (holdTerm && i === 0 && !this.skip) {
      this.held = [this.buf];
      this.heldLen = this.buf.length;
      this.heldTerm = holdTerm;
      this.heldMax = holdMax;
      this.heldTail = this.buf.slice(this.buf.length - (holdTerm.length - 1));
      this.buf = '';
    }
    if (out.length) this.emitted = true;
    return out;
  }

  end(): XmlToken[] {
    this.joinHeld();
    const rest = this.buf;
    this.buf = '';
    if (this.skip || this.garbage) { // already reported when the construct was discarded
      this.skip = null; this.garbage = false;
      this.sink.span('bad', rest);
      return [];
    }
    if (this.dtd) {
      const { line, over } = this.dtd;
      this.dtd = null;
      this.sink.span('doctype', rest); // ends the streamed construct
      if (over) return []; // already reported when it grew past the cap
      return [{ type: 'error', message: 'declaration is unterminated or too long, skipping it', code: 'unterminated-declaration', params: {}, line }];
    }
    // the rest is an incomplete construct, or the held-back tail of a text run (a possibly split reference)
    const restLine = rest ? this.sink.span(rest.startsWith('<') ? 'bad' : 'text', rest) : 0;
    const line = (this.pendingText !== null ? this.pendingTextLine : 0) || restLine;
    const leftover = (this.pendingText ?? '') + rest;
    this.pendingText = null;
    if (!leftover.trim()) return [];
    return [{ type: 'error', message: 'unterminated content at end of document', code: 'unterminated-content', params: {}, line }];
  }
}
