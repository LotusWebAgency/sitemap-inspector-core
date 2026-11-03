import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_XML_LINE, XmlPrinter, type LayoutSink } from './printer.js';
import { SitemapParser } from './parser.js';
import { XmlTokenizer, type XmlToken } from './tokenizer.js';
import type { UrlRecord } from './types.js';

// The document through tokenizer and printer, fed in pieces of `size` characters; `spans` records what the sink got.
function layout(doc: string, size = doc.length || 1) {
  const rows: string[] = [];
  const spans: string[] = [];
  const printer = new XmlPrinter((r) => rows.push(...r));
  const sink: LayoutSink = {
    span: (kind, raw, more) => { spans.push(raw); return printer.span(kind, raw, more); },
    get line() { return printer.line; },
  };
  const tk = new XmlTokenizer(sink);
  const tokens: XmlToken[] = [];
  for (let i = 0; i < doc.length; i += size) tokens.push(...tk.write(doc.slice(i, i + size)));
  tokens.push(...tk.end());
  printer.finish();
  return { rows, spans, tokens, line: printer.line, bare: tk.bareAmpersands };
}

const rowsOf = (doc: string) => layout(doc).rows;
const nonWs = (s: string) => s.replace(/[ \t\r\n]/g, '');
// The tokenizer rebuffers an incomplete construct on every write, so one-character feeds stay on the shorter documents.
const sizesFor = (doc: string, sizes: number[]) => sizes.filter((s) => s >= 64 || doc.length < 20_000);

// Feeds spans straight to a printer.
function direct(spans: [Parameters<XmlPrinter['span']>[0], string, boolean?][]) {
  const rows: string[] = [];
  const p = new XmlPrinter((r) => rows.push(...r));
  const lines = spans.map(([k, raw, more]) => p.span(k, raw, more));
  p.finish();
  return { rows, lines, line: p.line };
}

describe('XmlPrinter format rules', () => {
  it('puts one construct per row, indented two spaces per level, with a leaf element on one row', () => {
    expect(rowsOf('<?xml version="1.0"?><urlset><url><loc>https://a.com/</loc><lastmod>2026</lastmod></url></urlset>')).toEqual([
      '<?xml version="1.0"?>', '<urlset>', '  <url>', '    <loc>https://a.com/</loc>', '    <lastmod>2026</lastmod>', '  </url>', '</urlset>',
    ]);
  });

  it('keeps an empty element on one row and gives a self-closed tag its own', () => {
    expect(rowsOf('<a><b></b><c/></a>')).toEqual(['<a>', '  <b></b>', '  <c/>', '</a>']);
  });

  it('trims the whitespace around a text run (D1) and drops a whitespace-only run', () => {
    expect(rowsOf('<loc>\n   https://a.com/  \r\n</loc>')).toEqual(['<loc>https://a.com/</loc>']);
    expect(rowsOf('<a>\n  \t\n</a>')).toEqual(['<a></a>']);
    expect(rowsOf('<a>  \n  <b/>\n</a>')).toEqual(['<a>', '  <b/>', '</a>']);
  });

  it('starts mixed content text on its own row at the child indent', () => {
    expect(rowsOf('<a>x<b/>y<!--c-->z</a>')).toEqual(['<a>x', '  <b/>', '  y', '  <!--c-->', '  z', '</a>']);
  });

  it('joins CDATA to a leaf and keeps text, CDATA and comments verbatim, entities undecoded', () => {
    expect(rowsOf('<a>x &amp; <![CDATA[<y>]]> z</a>')).toEqual(['<a>x &amp;<![CDATA[<y>]]>z</a>']);
    expect(rowsOf('<a><b/><![CDATA[q]]></a>')).toEqual(['<a>', '  <b/>', '  <![CDATA[q]]>', '</a>']);
  });

  it('prints tags byte for byte and collapses line breaks between attributes outside quotes (D2)', () => {
    expect(rowsOf('<urlset   xmlns="a"\n    xmlns:x=\'b\'\r\n  >')).toEqual(['<urlset   xmlns="a" xmlns:x=\'b\' >']);
    expect(rowsOf('<a\n x="1\n2"\n y="3"/>')).toEqual(['<a x="1', '2" y="3"/>']); // a quoted value is left alone
    expect(rowsOf("<a it's\n x=\"1\">t</a\n>")).toEqual(["<a it's x=\"1\">t</a >"]); // a stray apostrophe opens no quote
  });

  it('ends a row at every line break inside a construct, continuation rows verbatim', () => {
    expect(rowsOf('<a><!-- one\r\ntwo\rthree\n\n  four --></a>')).toEqual(['<a>', '  <!-- one', 'two', 'three', '', '  four -->', '</a>']);
    expect(rowsOf('<a>one\ntwo</a>')).toEqual(['<a>one', 'two</a>']);
  });

  it('treats a CR and LF split across spans as one break', () => {
    expect(direct([['bad', 'x\r', true], ['bad', '\ny']]).rows).toEqual(['x', 'y']);
    expect(direct([['open', '<a>'], ['text', 'x\r'], ['text', '\ny'], ['close', '</a>']]).rows).toEqual(['<a>x', 'y</a>']);
    expect(direct([['bad', 'x\r', true], ['bad', 'y']]).rows).toEqual(['x', 'y']);
    for (let cut = 1; cut < 12; cut++) {
      const doc = '<!--a\r\nb\r\n-->';
      expect(layout(doc, cut).rows, `cut ${cut}`).toEqual(['<!--a', 'b', '-->']);
    }
  });

  it('caps the indent at 32 levels and never goes below zero', () => {
    const rows = rowsOf(`${'<a>'.repeat(40)}${'</a>'.repeat(40)}</b></c><d/>`);
    expect(Math.max(...rows.map((r) => r.length - r.trimStart().length))).toBe(64);
    expect(rows.slice(-3)).toEqual(['</b>', '</c>', '<d/>']);
  });

  it('cuts a long row into pieces of exactly MAX_XML_LINE, a full row continuing into the next', () => {
    const rows = rowsOf(`<a>${'x'.repeat(20_000)}</a>`);
    expect(rows.map((r) => r.length)).toEqual([MAX_XML_LINE, MAX_XML_LINE, 20_007 - 2 * MAX_XML_LINE]);
    expect(rows.join('')).toBe(`<a>${'x'.repeat(20_000)}</a>`);
    expect(rowsOf(`<a>${'x'.repeat(MAX_XML_LINE - 3)}</a>`).map((r) => r.length)).toEqual([MAX_XML_LINE, 4]); // the close cannot fit: next row
  });

  it('returns the line a construct starts on, past a full row', () => {
    const { lines } = direct([['open', `<a ${'x'.repeat(MAX_XML_LINE - 4)}>`], ['text', 'y'], ['close', '</a>'], ['self', '<b/>']]);
    expect(lines).toEqual([1, 2, 2, 3]);
  });

  it('numbers a text run by its first non-whitespace character, 0 before one', () => {
    const { lines } = direct([['open', '<a>'], ['text', '  '], ['text', '\n x'], ['text', ' y'], ['close', '</a>']]);
    expect(lines).toEqual([1, 0, 1, 1, 1]);
    expect(direct([['self', '<b/>'], ['text', '\n\n  t']]).lines).toEqual([1, 2]);
  });

  it('holds trailing whitespace up to 8,192 characters and writes a longer run in whole pieces of that size, whatever the span split', () => {
    expect(direct([['open', '<a>'], ['text', 'x'], ['text', ' '.repeat(100)], ['text', 'y'], ['close', '</a>']]).rows).toEqual([`<a>x${' '.repeat(100)}y</a>`]);
    expect(direct([['open', '<a>'], ['text', 'x'], ['text', ' '.repeat(100)], ['close', '</a>']]).rows).toEqual(['<a>x</a>']);
    const flood = (pieces: string[]) => direct([['open', '<a>'], ['text', 'x'], ...pieces.map((p): ['text', string] => ['text', p]), ['close', '</a>']]).rows.join('');
    const split = (n: number) => Array.from({ length: Math.ceil(9000 / n) }, (_, i) => ' '.repeat(Math.min(n, 9000 - i * n)));
    for (const n of [9000, 4096, 500, 7, 1]) expect(flood(split(n)), `pieces of ${n}`).toBe(`<a>x${' '.repeat(MAX_XML_LINE)}</a>`);
    expect(flood([' '.repeat(MAX_XML_LINE)])).toBe('<a>x</a>');
  });

  it('continues a construct whose span said `more`, whatever kind the next span names', () => {
    const { rows, lines } = direct([['self', '<a/>'], ['doctype', '<!DOCTYPE', true], ['doctype', ' x [\n', true], ['doctype', ']>'], ['self', '<b/>']]);
    expect(rows).toEqual(['<a/>', '<!DOCTYPE x [', ']>', '<b/>']);
    expect(lines).toEqual([1, 2, 2, 2, 4]);
  });

  it('hands rows over in fresh batches of 1,000 and keeps none without a callback', () => {
    const batches: string[][] = [];
    const p = new XmlPrinter((r) => batches.push(r));
    for (let i = 0; i < 2500; i++) p.span('self', '<a/>');
    p.finish();
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(new Set(batches).size).toBe(3);
    const silent = new XmlPrinter();
    for (let i = 0; i < 2500; i++) silent.span('self', '<a/>');
    silent.finish();
    expect(silent.line).toBe(2500);
  });
});

describe('XmlPrinter plain mode', () => {
  function plain(pieces: string[]) {
    const rows: string[] = [];
    const p = new XmlPrinter((r) => rows.push(...r));
    const lines = pieces.map((s) => p.plain(s));
    p.finish();
    return { rows, lines };
  }

  it('makes each source line a row, drops a trailing CR, keeps blank lines and adds no row for a final newline', () => {
    expect(plain(['https://a.com/1\r\n\nhttps://a.com/2\n']).rows).toEqual(['https://a.com/1', '', 'https://a.com/2']);
  });

  it('ends a line at a lone CR, and reads a CR at a chunk end plus the LF after it as one break', () => {
    expect(plain(['a\r', '\nb\r', 'c']).rows).toEqual(['a', 'b', 'c']);
    expect(plain(['https://a.com/1\rhttps://a.com/2\r\rhttps://a.com/3\r']).rows).toEqual(['https://a.com/1', 'https://a.com/2', '', 'https://a.com/3']);
    expect(plain(['a\r\n', 'b\r', '\r\n', 'c']).rows).toEqual(['a', 'b', '', 'c']);
  });

  it('cuts a long line and returns the row each piece starts on', () => {
    const { rows, lines } = plain(['x'.repeat(MAX_XML_LINE + 5), '\n', 'y', '\n', '\n', 'z']);
    expect(rows.map((r) => r.length)).toEqual([MAX_XML_LINE, 5, 1, 0, 1]);
    expect(lines).toEqual([1, 2, 3, 3, 4, 5]);
  });
});

// Random documents built from every kind of construct, well-formed or not, with mixed line breaks and whitespace.
function randomDoc(seed: number): string {
  let s = seed;
  const rand = (n: number) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };
  const ws = () => ['', ' ', '\n', '\r\n', '\r', '\t  ', '\n\n   '][rand(7)] ?? '';
  const word = () => ['https://a.com/p', 'x', 'é𝄞', 'a&amp;b', 'a&b', '&#38;', '&am', ''][rand(8)] ?? '';
  const parts: string[] = [];
  for (let k = 0, n = 5 + rand(60); k < n; k++) {
    switch (rand(16)) {
      case 0: parts.push(`<url>${ws()}<loc>${ws()}${word()}${ws()}</loc>${ws()}</url>`); break;
      case 1: parts.push(`<a${ws() || ' '}x="1${ws()}2"${ws()}y='>'${ws()}>`); break;
      case 2: parts.push(`</a${ws()}>`); break;
      case 3: parts.push(`<b${ws()}/>`); break;
      case 4: parts.push(`<!--${ws()}c${ws()}-->`); break;
      case 5: parts.push(`<![CDATA[${ws()}<d>${ws()}]]>`); break;
      case 6: parts.push(`<?pi${ws()}?>`); break;
      case 7: parts.push(`<!DOCTYPE x [${ws()}<!ENTITY e "y">${ws()}]>`); break;
      case 8: parts.push(word() + ws() + word()); break;
      case 9: parts.push(rand(12) === 0 ? ' \n'.repeat(5000) : ws()); break;
      case 10: parts.push(`<<${ws()}oops`); break;
      case 11: parts.push(`</ bad${ws()}>`); break;
      case 12: parts.push('x'.repeat(rand(3) === 0 ? 9000 : 10)); break;
      case 13: parts.push(`<urlset${ws()}xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`); break;
      case 14: parts.push(`<${'e'.repeat(rand(2) ? 3 : 70_000)}`); break;
      default: parts.push(['<!--', '<![CDATA[', '<!DOCTYPE', '<?', '<x', '&'][rand(6)] ?? ''); break;
    }
  }
  return parts.join('');
}

describe('layout properties over random documents and chunkings', () => {
  const docs = Array.from({ length: 60 }, (_, k) => randomDoc(k + 1));
  const fixtures = readdirSync('test/fixtures', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(`test/fixtures/${e.name}`, 'utf8'));

  it('feeds every input character to the sink exactly once, in order, at any chunk size', () => {
    for (const [k, doc] of [...docs, ...fixtures].entries()) {
      for (const size of sizesFor(doc, [1, 2, 3, 7, 64, 1000, doc.length || 1])) expect(layout(doc, size).spans.join(''), `doc ${k} size ${size}`).toBe(doc);
    }
  });

  it('prints the same rows and tokens at any chunk size', () => {
    for (const [k, doc] of docs.entries()) {
      const whole = layout(doc);
      for (const size of sizesFor(doc, [1, 3, 5, 17, 64, 4096])) {
        const r = layout(doc, size);
        expect(r.rows, `doc ${k} size ${size}`).toEqual(whole.rows);
        expect(r.tokens, `doc ${k} size ${size}`).toEqual(whole.tokens);
        expect(r.bare, `doc ${k} size ${size}`).toBe(whole.bare);
      }
    }
  });

  it('keeps the non-whitespace content, bounds every row and numbers every token inside the rows', () => {
    for (const [k, doc] of [...docs, ...fixtures].entries()) {
      const { rows, tokens, line } = layout(doc, doc.length < 20_000 ? 13 : 64);
      expect(nonWs(rows.join('')), `doc ${k}`).toBe(nonWs(doc));
      expect(line, `doc ${k}`).toBe(rows.length);
      for (const r of rows) {
        expect(r.length, `doc ${k}`).toBeLessThanOrEqual(MAX_XML_LINE);
        expect(/[\r\n]/.test(r), `doc ${k}`).toBe(false);
      }
      for (const t of tokens) {
        expect(t.line, `doc ${k} ${t.type}`).toBeGreaterThanOrEqual(1);
        expect(t.line, `doc ${k} ${t.type}`).toBeLessThanOrEqual(rows.length);
      }
    }
  });

  it('puts every record on a row holding its <url>, and every issue and record line within the rows', () => {
    const urlsets = [
      ...docs.map((d) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${d}</urlset>`),
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: 3000 }, (_, i) => `<url><loc>https://a.com/${i}</loc></url>`).join('')}</urlset>`,
      ...fixtures,
    ];
    for (const [k, doc] of urlsets.entries()) {
      const records: UrlRecord[] = [];
      const rows: string[] = [];
      const p = new SitemapParser({ onRecords: (r) => records.push(...r), onLines: (l) => rows.push(...l) });
      const size = doc.length < 20_000 ? 11 : 64;
      for (let i = 0; i < doc.length; i += size) p.write(doc.slice(i, i + size));
      const result = p.finish();
      for (const r of records) expect(rows[r.line - 1], `doc ${k} ${r.loc}`).toMatch(/<url[\s>/]/);
      for (const i of result.issues) expect(i.line, `doc ${k} ${i.detail}`).toBeLessThanOrEqual(Math.max(1, rows.length));
      for (const c of result.children) expect(rows[c.line - 1], `doc ${k}`).toContain('<sitemap');
    }
  });

  it('starts every record of a plain-text sitemap on the row of its line', () => {
    const doc = 'https://a.com/1\r\n\n  https://a.com/2  \nhttps://a.com/' + 'x'.repeat(9000) + '\r\nhttps://a.com/4';
    for (const size of [1, 7, 100, doc.length]) {
      const records: UrlRecord[] = [];
      const rows: string[] = [];
      const p = new SitemapParser({ onRecords: (r) => records.push(...r), onLines: (l) => rows.push(...l) });
      for (let i = 0; i < doc.length; i += size) p.write(doc.slice(i, i + size));
      expect(p.finish().text).toBe(true);
      expect(rows.length, `size ${size}`).toBe(6);
      expect(records.map((r) => r.line), `size ${size}`).toEqual([1, 3, 4, 6]);
      for (const r of records) expect(rows[r.line - 1]!.trim().startsWith(r.loc.slice(0, 20)), `size ${size}`).toBe(true);
    }
  });
});

describe('whitespace and line breaks do not depend on where the input is split', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

  function parsed(doc: string, size: number) {
    const records: UrlRecord[] = [];
    const rows: string[] = [];
    const p = new SitemapParser({ onRecords: (r) => records.push(...r), onLines: (l) => rows.push(...l) });
    for (let i = 0; i < doc.length; i += size) p.write(doc.slice(i, i + size));
    const result = p.finish();
    return { rows, records, result };
  }

  it('flushes held whitespace past 8,192 characters by the run length alone', () => {
    const doc = `<urlset ${NS}>\n<url><loc>https://a.com/x` + '\n'.repeat(9000) + '</loc></url>\n<url><loc>https://a.com/y</loc></url></urlset>';
    const whole = parsed(doc, doc.length);
    expect(whole.records.map((r) => r.line)).toEqual([2, 8197]);
    for (const size of [1, 7, 500, 8000]) {
      const r = parsed(doc, size);
      expect(r.rows, `size ${size}`).toEqual(whole.rows);
      expect(r.records, `size ${size}`).toEqual(whole.records);
    }
  });

  it('writes a whitespace run that content follows in full, however it is split', () => {
    const doc = `<a>x${' \n'.repeat(5000)}y</a>`;
    const whole = layout(doc);
    expect(whole.rows.length).toBeGreaterThan(5000);
    for (const size of [1, 7, 500, 8000]) expect(layout(doc, size).rows, `size ${size}`).toEqual(whole.rows);
  });

  it('reads the lines of a plain-text sitemap with lone CR breaks the same at any chunk size', () => {
    const doc = 'https://a.com/1\rhttps://a.com/2\r\nhttps://a.com/3\r\rhttps://a.com/4\n\rhttps://a.com/5\r';
    for (const size of [1, 2, 3, 7, doc.length]) {
      const r = parsed(doc, size);
      expect(r.result.text, `size ${size}`).toBe(true);
      expect(r.rows, `size ${size}`).toEqual(['https://a.com/1', 'https://a.com/2', 'https://a.com/3', '', 'https://a.com/4', '', 'https://a.com/5']);
      expect(r.records.map((x) => [x.loc, x.line]), `size ${size}`).toEqual([1, 2, 3, 5, 7].map((n, i) => [`https://a.com/${i + 1}`, n]));
      for (const row of r.rows) expect(/[\r\n]/.test(row)).toBe(false);
    }
  });
});

describe('pathological inputs stay linear', () => {
  const CHUNK = 65_536;
  // Feeds `count` chunks of `piece` between `head` and `tail` through tokenizer and printer; returns the time and the rows.
  function stream(head: string, piece: string, count: number, tail: string) {
    let rows = 0;
    let longest = 0;
    const printer = new XmlPrinter((r) => { rows += r.length; for (const x of r) if (x.length > longest) longest = x.length; });
    const tk = new XmlTokenizer(printer);
    const t0 = performance.now();
    const tokens = [...tk.write(head)];
    for (let i = 0; i < count; i++) tokens.push(...tk.write(piece));
    tokens.push(...tk.write(tail), ...tk.end());
    printer.finish();
    return { ms: performance.now() - t0, rows, longest, tokens, line: printer.line };
  }

  it('10 MB of text with no "<"', () => {
    const r = stream('', 'w'.repeat(CHUNK), 160, '');
    expect(r.ms).toBeLessThan(3000);
    expect(r.rows).toBe(Math.ceil(160 * CHUNK / MAX_XML_LINE));
    expect(r.longest).toBe(MAX_XML_LINE);
  });

  it('a million nested open tags', () => {
    const r = stream('', '<a>'.repeat(CHUNK / 4), 61, '');
    expect(r.ms).toBeLessThan(3000);
    expect(r.rows).toBe(61 * CHUNK / 4);
    expect(r.longest).toBe(64 + 3);
  });

  it('150 MB of unterminated comment, streamed', () => {
    const r = stream('<a><!--', 'x'.repeat(CHUNK), 2400, '--><b/></a>');
    expect(r.ms).toBeLessThan(5000);
    // <a>, then "  <!--" and 157,286,400 characters in 19,201 rows (the last ends with -->), then <b/> and </a>
    expect(r.rows).toBe(1 + Math.ceil((6 + 2400 * CHUNK) / MAX_XML_LINE) + 2);
    expect(r.tokens.map((t) => t.type)).toEqual(['open', 'error', 'open', 'close']);
    expect(r.tokens[2]!.line).toBe(r.line - 1);
    expect(r.longest).toBe(MAX_XML_LINE);
  });

  it('10 MB of short lines inside a comment', () => {
    const r = stream('<a><!--', 'x\n'.repeat(CHUNK / 2), 160, '--></a>');
    expect(r.ms).toBeLessThan(5000);
    expect(r.rows).toBe(160 * CHUNK / 2 + 3); // <a>, the comment's first row, one more per line break (the last holds -->), </a>
  });

  it('a 64K tag, whole or fed in small pieces, with line breaks between its attributes', () => {
    const attrs = Array.from({ length: 6500 }, (_, i) => `\n a${i}="v"`).join('').slice(0, 65_000);
    const doc = `<a${attrs}>t</a>`;
    for (const size of [doc.length, 100]) {
      const t0 = performance.now();
      const { rows, tokens } = layout(doc, size);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(tokens[0]).toMatchObject({ type: 'open', name: 'a', line: 1 });
      expect(rows.join('')).toBe(doc.replace(/\n /g, ' '));
    }
  });

  it('a whitespace flood inside a text run', () => {
    const r = stream('<a>x', ' \n'.repeat(CHUNK / 2), 160, 'y</a><b>z');
    expect(r.ms).toBeLessThan(3000);
    const tail = stream('<a>x', ' \n'.repeat(CHUNK / 2), 160, '</a>');
    expect(tail.ms).toBeLessThan(3000);
    expect(tail.rows).toBeGreaterThan(1); // flushed past the hold cap, verbatim
  });
});
