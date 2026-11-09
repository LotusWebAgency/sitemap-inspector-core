import { describe, expect, it } from 'vitest';
import { SitemapParser } from './parser.js';
import { XmlPrinter } from './printer.js';
import { XmlTokenizer } from './tokenizer.js';
import type { UrlRecord } from './types.js';

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// A generated document: entities, quoted '>' and '<', CDATA, comments, PIs, namespaces, non-ASCII and astral text,
// long attribute values and a few malformed constructs.
function generate(seed: number): string {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const texts = ['plain', 'a &amp; b', 'x &lt;y&gt; &quot;z&quot; &apos;', 'café €', 'astral \u{1d11e} \u{1f600}', '&#65;&#x42;&#xd800;&#0;', 'bare & amp', '&unknown; &#99999999999;', '&amp', ' nb　sp﻿'];
  const ws = [' ', '\n', '\t', ' ', ' ', '\r\n'];
  const parts = [pick(['', '<?xml version="1.0" encoding="UTF-8"?>\n', '<?xml version="1.0"?>\n<!DOCTYPE urlset [<!ENTITY e "x>y">]>\n', '<!-- lead -->\n'])];
  parts.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:v="http://www.google.com/schemas/sitemap-video/1.1">');
  const urls = 4 + Math.floor(r() * 8);
  for (let i = 0; i < urls; i++) {
    parts.push(pick(['', '\n  ', '<!-- c > <u> -->', '<?pi x > y?>']));
    parts.push('<url>');
    parts.push(`<loc>https://a.com/${i}/${pick(texts)}</loc>`);
    if (r() < 0.6) parts.push(`<lastmod>2026-0${1 + Math.floor(r() * 9)}-01</lastmod>`);
    if (r() < 0.3) parts.push(`<priority>0.${Math.floor(r() * 10)}</priority><changefreq>weekly</changefreq>`);
    if (r() < 0.3) parts.push(`<![CDATA[ <loc>${pick(texts)}</loc> ]]>`);
    for (let a = Math.floor(r() * 4); a > 0; a--) {
      const q = pick(['"', "'"]);
      const href = `https://a.com/${pick(texts).replace(/["']/g, '')}/${r() < 0.2 ? '>>>>><<' : ''}?a=1&b=2`;
      parts.push(`<xhtml:link${pick(ws)}rel=${q}alternate${q}${pick(ws)}hreflang${pick(['=', ' = '])}${q}${pick(['en', 'de-AT', 'x-default'])}${q} href${pick(['=', '\n=\n'])}${q}${href}${q}${pick(['', ' ', '/'])}${r() < 0.5 ? '/' : ''}>`);
    }
    if (r() < 0.3) parts.push(`<image:image><image:loc>https://a.com/i${i}.jpg</image:loc></image:image>`);
    if (r() < 0.15) parts.push(`<v:video><v:title a="${'t'.repeat(Math.floor(r() * 9000))}">${pick(texts)}</v:title></v:video>`);
    if (r() < 0.15) parts.push(pick(['<a b="x>', '<9bad/>', '<a\u0001b c="1"/>', '</bad name>', '<a "q"=">">', '<a b=">\'">']));
    parts.push(pick(['</url>', '</ url >', '</url\n>']));
  }
  parts.push(pick(['</urlset>', '</urlset>\n', '</urlset', '</urlset><']));
  return parts.join('');
}

function run(xml: string, sizes: () => number) {
  const batches: { records: UrlRecord[]; ext: unknown }[] = [];
  const lines: string[] = [];
  const p = new SitemapParser({ onRecords: (records, ext) => batches.push({ records, ext }), onLines: (l) => lines.push(...l) });
  for (let i = 0; i < xml.length;) { const n = sizes(); p.write(xml.slice(i, i + n)); i += n; }
  return { result: p.finish(), batches, lines };
}

describe('SitemapParser chunking invariance', () => {
  it('gives the same records, hits, rows, issues and stats at any chunking', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const xml = generate(seed);
      const whole = run(xml, () => xml.length || 1);
      const r = rng(seed * 7919);
      for (const sizes of [() => 1, () => 2, () => 7, () => 1 + Math.floor(r() * 5), () => 1 + Math.floor(r() * 200), () => 4096]) {
        const got = run(xml, sizes);
        expect(got.result, `seed ${seed}`).toEqual(whole.result);
        expect(got.batches, `seed ${seed}`).toEqual(whole.batches);
        expect(got.lines, `seed ${seed}`).toEqual(whole.lines);
      }
      expect(whole.result.stats.byteSize, `seed ${seed}`).toBe(Buffer.byteLength(xml));
    }
  });

  it('pins the output for generated seed 1, so the invariance above compares against known-good values', () => {
    const xml = generate(1);
    const { result, batches } = run(xml, () => xml.length);
    expect(batches.flatMap((b) => b.records)).toEqual([
      { loc: 'https://a.com/0/\u00a0nb\u3000sp', line: 5, changefreq: 'weekly', priority: '0.6', alternates: [{ hreflang: 'en', href: 'https://a.com/astral \u{1d11e} \u{1f600}/?a=1&b=2' }] },
      {
        loc: 'https://a.com/1/AB&#xd800;&#0;', line: 11, changefreq: 'weekly', priority: '0.2', images: 1,
        alternates: [{ hreflang: 'en', href: 'https://a.com/a & b/?a=1&b=2' }, { hreflang: 'en', href: 'https://a.com/x <y> "z" \'/>>>>><<?a=1&b=2' }],
      },
      {
        loc: 'https://a.com/2/bare & amp', line: 21, images: 1,
        alternates: [
          { hreflang: 'x-default', href: 'https://a.com/\u00a0nb\u3000sp\ufeff/>>>>><<?a=1&b=2' },
          { hreflang: 'de-AT', href: 'https://a.com/bare & amp/?a=1&b=2' },
          { hreflang: 'en', href: 'https://a.com/AB&#xd800;&#0;/?a=1&b=2' },
        ],
      },
      {
        loc: 'https://a.com/3/plain', line: 33, lastmod: '2026-07-01', images: 1,
        alternates: [{ hreflang: 'en', href: 'https://a.com/&unknown; &#99999999999;/?a=1&b=2' }, { hreflang: 'x-default', href: 'https://a.com/&unknown; &#99999999999;/?a=1&b=2' }],
      },
    ]);
    expect(result.issues.map((i) => [i.detail, i.line])).toEqual([
      ['malformed-tag', 16], ['close-mismatch', 20], ['malformed-tag', 23], ['close-mismatch', 32], ['close-mismatch', 42], ['unterminated-content', 44],
    ]);
    expect(result.bareAmpersands).toBe(20);
    expect(result.stats).toEqual({
      urlCount: 4, byteSize: Buffer.byteLength(xml), lastmodMin: '2026-07-01', lastmodMax: '2026-07-01', topLastmodShare: 0.25, duplicateCount: 0,
      languages: ['en', 'x-default', 'de-AT'], clusterCount: 4, clustersWithoutXDefault: 2, hasPriority: true, hasChangefreq: true, imageCount: 3, newsCount: 0, videoCount: 1,
    });
  });

  it('counts the UTF-8 bytes of a chunk past the encoder scratch buffer', () => {
    const text = `<urlset><url><loc>https://a.com/${'€\u{1f600}'.repeat(30000)}</loc></url></urlset>`;
    const p = new SitemapParser({ onRecords: () => {} });
    p.write(text);
    expect(p.finish().stats.byteSize).toBe(Buffer.byteLength(text));
  });
});

describe('XmlTokenizer tag names', () => {
  it('ends a tag name at exactly the characters of the regex class \\s', () => {
    for (let c = 0; c < 0x10000; c++) {
      if (c === 0x3c || c === 0x3e) continue; // '<' and '>' end or break the tag before the name is read
      const ch = String.fromCharCode(c);
      const tokens = new XmlTokenizer(new XmlPrinter()).write(`<a${ch}x="1"/>`);
      const isSpace = /\s/.test(ch);
      expect(tokens.map((t) => t.type), `U+${c.toString(16)}`).toEqual(isSpace ? ['open'] : ['error']);
      if (isSpace) expect(tokens[0]).toMatchObject({ name: 'a', attrs: { x: '1' }, selfClosing: true });
    }
  });

  it('trims a closing tag name the way trim() does', () => {
    for (let c = 0; c < 0x10000; c++) {
      if (c === 0x3c || c === 0x3e) continue;
      const ch = String.fromCharCode(c);
      const tokens = new XmlTokenizer(new XmlPrinter()).write(`</${ch}a${ch}>`);
      expect(tokens.map((t) => t.type), `U+${c.toString(16)}`).toEqual([/^[\s\w:.-]$/.test(ch) ? 'close' : 'error']);
    }
  });
});
