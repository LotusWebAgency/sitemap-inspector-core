export type SpanKind = 'decl' | 'pi' | 'comment' | 'doctype' | 'cdata' | 'open' | 'self' | 'close' | 'text' | 'bad';

export interface LayoutSink {
  /** One consumed span of input, in document order. `more`: the construct continues in the next call (streamed DOCTYPE, discarded construct). Returns the 1-based XML-tab line the construct starts on (0 for a text run with no content yet). */
  span(kind: SpanKind, raw: string, more?: boolean): number;
  /** The last line started so far, 0 before any. */
  readonly line: number;
}

/** XML-tab rows are stored in pieces of at most this many characters, and a piece of exactly this length continues into the next row. */
export const MAX_XML_LINE = 8192;
/** A stored row of exactly MAX_XML_LINE characters is a piece that continues into the next row without a line break. */
export const continuesRow = (row: string): boolean => row.length === MAX_XML_LINE;
const MAX_INDENT_DEPTH = 32;
const ROW_FLUSH = 1000;
const MAX_WS_HOLD = 8192;
const INDENTS = Array.from({ length: MAX_INDENT_DEPTH + 1 }, (_, d) => '  '.repeat(d));
const LF = 10, CR = 13;

const isWs = (c: number) => c === 32 || c === 9 || c === LF || c === CR;

// A tag that spans source lines gets each whitespace run holding a line break collapsed to one space, outside quoted values.
// Quotes only open right after '=', as in the tokenizer's scanTag, so a stray apostrophe cannot swallow the tag.
function collapseTag(tag: string): string {
  if (!tag.includes('\n') && !tag.includes('\r')) return tag;
  const n = tag.length;
  let out = '';
  let from = 0;
  let quote = 0;
  let eq = false;
  for (let p = 0; p < n; p++) {
    const c = tag.charCodeAt(p);
    if (quote) { if (c === quote) quote = 0; continue; }
    if (isWs(c)) {
      let e = p;
      let breaks = false;
      for (; e < n && isWs(tag.charCodeAt(e)); e++) if (tag.charCodeAt(e) === LF || tag.charCodeAt(e) === CR) breaks = true;
      if (breaks) { out += `${tag.slice(from, p)} `; from = e; }
      p = e - 1;
      continue;
    }
    if (c === 34 || c === 39) { if (eq) quote = c; eq = false; } else if (c === 61) eq = true; else if (c > 32) eq = false;
  }
  return out + tag.slice(from);
}

/**
 * The XML tab: lays the tokenizer's consumed spans out as indented rows, one construct per row, with a leaf element's
 * text and close tag joined to its open tag. Rows never hold a line break and are cut into MAX_XML_LINE pieces; every
 * buffer is bounded (row, held whitespace, batch of ROW_FLUSH rows), so memory does not grow with the input.
 */
export class XmlPrinter implements LayoutSink {
  private cur: string | null = null; // the row being written
  private rows = 0; // rows started
  private batch: string[] = [];
  private brk = false; // a line break was read: the next character of the same construct starts a continuation row
  private cr = false; // the last character read was a CR, so a LF right after it is part of the same break
  private depth = 0;
  private leaf = false; // the current row holds an open tag that text, CDATA and its close tag still join
  private cont = 0; // the line of a construct that continues in the next span, 0 when none does
  private inRun = false; // consecutive text spans are one run
  private runLine = 0; // line of the run's first non-whitespace character, 0 before one
  private wsHold = ''; // whitespace after the run's last content so far: written if more content follows, dropped at the run's end
  private plainStart = true; // plain mode: the next character starts a source line
  private plainSkipLf = false; // plain mode: the last character read was a CR break, so a LF right after it is part of it

  constructor(private readonly onRows?: (rows: string[]) => void) {}

  get line(): number { return this.rows; }

  span(kind: SpanKind, raw: string, more = false): number {
    if (this.cont) {
      const line = this.cont;
      this.put(raw);
      this.cont = more ? line : 0;
      return line;
    }
    if (kind === 'text') return this.text(raw);
    if (!raw) return this.rows;
    this.endRun();
    const tag = kind === 'open' || kind === 'self' || kind === 'close';
    const s = tag ? collapseTag(raw) : raw;
    let line: number;
    if (this.leaf && (kind === 'cdata' || kind === 'close')) {
      line = this.put(s);
    } else {
      if (kind === 'close') this.depth = Math.max(0, this.depth - 1);
      this.newRow();
      line = this.rows;
      this.put(s);
    }
    if (kind === 'close') {
      if (this.leaf) this.depth = Math.max(0, this.depth - 1);
      this.leaf = false;
    } else if (kind !== 'cdata') this.leaf = false;
    if (kind === 'open') { this.leaf = true; this.depth++; }
    if (more) this.cont = line;
    return line;
  }

  /** Plain-text sitemaps: each source line is one row (a break is \n, \r\n or a lone \r), cut like any other. Returns the line `s` starts on. */
  plain(s: string): number {
    const n = s.length;
    let from = 0;
    if (this.plainSkipLf) { this.plainSkipLf = false; if (n && s.charCodeAt(0) === LF) from = 1; }
    let first = 0;
    let nl = -2;
    let cr = -2;
    while (from < n) {
      if (nl !== -1 && nl < from) nl = s.indexOf('\n', from);
      if (cr !== -1 && cr < from) cr = s.indexOf('\r', from);
      const br = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
      const end = br === -1 ? n : br;
      if (end > from) {
        if (this.plainStart) { this.startRow(''); this.plainStart = false; }
        const line = this.append(s, from, end);
        first ||= line;
      }
      if (br === -1) break;
      if (this.plainStart) { this.startRow(''); first ||= this.rows; } // an empty line
      this.plainStart = true;
      from = br + 1;
      if (br === cr) {
        if (from === n) this.plainSkipLf = true;
        else if (s.charCodeAt(from) === LF) from++;
      }
    }
    return first || this.rows;
  }

  /** Writes out the last row and the batch. */
  finish(): void {
    this.endRun();
    this.cont = 0;
    if (this.cur !== null) this.emit(this.cur);
    this.cur = null;
    if (this.batch.length) { this.onRows?.(this.batch); this.batch = []; }
  }

  private text(s: string): number {
    if (!this.inRun) { this.inRun = true; this.runLine = 0; this.wsHold = ''; }
    const n = s.length;
    let a = 0;
    while (a < n && isWs(s.charCodeAt(a))) a++;
    if (a === n) { // whitespace only: leading whitespace is skipped, trailing is held
      if (this.runLine) this.hold(s);
      return this.runLine;
    }
    let b = n;
    while (isWs(s.charCodeAt(b - 1))) b--;
    if (this.runLine) {
      if (this.wsHold) { this.put(this.wsHold); this.wsHold = ''; }
      this.put(b === n ? s : s.slice(0, b));
    } else {
      if (!this.leaf) this.newRow();
      this.runLine = this.put(a === 0 && b === n ? s : s.slice(a, b));
    }
    if (b < n) this.hold(s.slice(b));
    return this.runLine;
  }

  // Held whitespace is written out in pieces of exactly MAX_WS_HOLD characters once more than that is held, so what is
  // written and what is dropped at the run's end depends on the run's length only, never on where spans split it.
  private hold(ws: string): void {
    const all = this.wsHold + ws;
    if (all.length <= MAX_WS_HOLD) { this.wsHold = all; return; }
    const keep = ((all.length - 1) % MAX_WS_HOLD) + 1;
    for (let at = 0; at < all.length - keep; at += MAX_WS_HOLD) this.put(all.slice(at, at + MAX_WS_HOLD));
    this.wsHold = all.slice(all.length - keep);
  }

  private endRun(): void {
    this.inRun = false;
    this.runLine = 0;
    this.wsHold = '';
  }

  private newRow(): void {
    this.startRow(INDENTS[Math.min(this.depth, MAX_INDENT_DEPTH)] ?? '');
    this.cr = false;
  }

  private startRow(indent: string): void {
    if (this.cur !== null) this.emit(this.cur);
    this.cur = indent;
    this.rows++;
    this.brk = false;
  }

  private emit(row: string): void {
    if (!this.onRows) return;
    this.batch.push(row);
    if (this.batch.length >= ROW_FLUSH) { this.onRows(this.batch); this.batch = []; }
  }

  // Writes s verbatim: each \n, \r\n or lone \r ends the row. Returns the line of the first character written (the
  // current line when none is). The next-break positions are cached, so a span with many breaks stays linear.
  private put(s: string): number {
    const n = s.length;
    let from = 0;
    if (this.cr) { this.cr = false; if (n && s.charCodeAt(0) === LF) from = 1; }
    let first = 0;
    let nl = -2;
    let cr = -2;
    while (from < n) {
      if (nl !== -1 && nl < from) nl = s.indexOf('\n', from);
      if (cr !== -1 && cr < from) cr = s.indexOf('\r', from);
      const br = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
      const end = br === -1 ? n : br;
      if (end > from) { const line = this.append(s, from, end); first ||= line; }
      if (br === -1) break;
      if (this.brk) this.startRow(''); // an empty source line inside the construct
      this.brk = true;
      from = br + 1;
      if (s.charCodeAt(br) === CR) {
        if (from === n) this.cr = true;
        else if (s.charCodeAt(from) === LF) from++;
      }
    }
    return first || this.rows;
  }

  // Appends s[from, end), which holds no line break, cutting the row at MAX_XML_LINE. Returns the line of its first character.
  private append(s: string, from: number, end: number): number {
    if (this.brk || this.cur === null) this.startRow('');
    let cur = this.cur ?? '';
    if (cur.length >= MAX_XML_LINE) { this.startRow(''); cur = ''; }
    const line = this.rows;
    while (end - from > MAX_XML_LINE - cur.length) {
      const take = MAX_XML_LINE - cur.length;
      this.cur = cur + s.slice(from, from + take);
      from += take;
      this.startRow('');
      cur = '';
    }
    this.cur = cur + s.slice(from, end);
    return line;
  }
}
