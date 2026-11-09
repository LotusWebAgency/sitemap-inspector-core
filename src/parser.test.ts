import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SitemapParser } from './parser.js';
import { EXAMPLE_MAX, type ExtensionHit } from './extensions.js';
import { MAX_XML_LINE } from './printer.js';
import { ValidationRun } from './validator.js';
import type { UrlRecord } from './types.js';

function parse(text: string, flushSize = 2000, chunkSize = 7) {
  const records: UrlRecord[] = [];
  const lines: string[] = [];
  const p = new SitemapParser({ onRecords: (r) => records.push(...r), onLines: (l) => lines.push(...l) }, flushSize);
  for (let i = 0; i < text.length; i += chunkSize) p.write(text.slice(i, i + chunkSize));
  return { result: p.finish(), records, lines };
}
const fx = (name: string) => readFileSync(`test/fixtures/${name}`, 'utf8');
// Line numbers are XML-tab rows: the first row holding `needle`, and every row that starts with it after the indent.
const lineOf = (rows: string[], needle: string) => rows.findIndex((r) => r.includes(needle)) + 1;
const rowsStarting = (rows: string[], start: string) => rows.flatMap((r, i) => (r.trimStart().startsWith(start) ? [i + 1] : []));

describe('SitemapParser', () => {
  it('parses a valid urlset', () => {
    const { result, records, lines } = parse(fx('valid-small.xml'));
    expect(result.kind).toBe('urlset');
    expect(result.issues).toEqual([]);
    const [l1, l2, l3] = rowsStarting(lines, '<url>');
    expect(records).toEqual([
      { loc: 'https://shop.example/', line: l1, lastmod: '2026-05-01', priority: '1.0' },
      { loc: 'https://shop.example/a', line: l2, lastmod: '2026-05-02T10:00:00Z', changefreq: 'daily' },
      { loc: 'https://shop.example/b?x=1&y=2', line: l3 },
    ]);
    expect([l1, l2, l3]).toEqual([3, 8, 13]);
    expect(result.stats).toEqual({
      urlCount: 3, byteSize: Buffer.byteLength(fx('valid-small.xml')), lastmodMin: '2026-05-01', lastmodMax: '2026-05-02T10:00:00Z', topLastmodShare: 1 / 3, duplicateCount: 0,
      languages: [], clusterCount: 0, clustersWithoutXDefault: 0, hasPriority: true, hasChangefreq: true, imageCount: 0, newsCount: 0, videoCount: 0,
    });
    expect(result.truncated).toBe(false);
    expect(result.bareAmpersands).toBe(0);
  });

  it('ignores invalid lastmod values when computing the lastmod range', () => {
    const xml = '<urlset><url><loc>https://a.com/1</loc><lastmod>2026-07-14</lastmod></url>'
      + '<url><loc>https://a.com/2</loc><lastmod>2026-9-15</lastmod></url>'
      + '<url><loc>https://a.com/3</loc><lastmod>2026-07-20T10:00:00Z</lastmod></url></urlset>';
    const { result, records } = parse(xml);
    expect(records[1]!.lastmod).toBe('2026-9-15');
    expect(result.stats.lastmodMin).toBe('2026-07-14');
    expect(result.stats.lastmodMax).toBe('2026-07-20T10:00:00Z');
  });

  it('leaves the lastmod range unset when every lastmod is invalid', () => {
    const { result } = parse('<urlset><url><loc>https://a.com/1</loc><lastmod>yesterday</lastmod></url></urlset>');
    expect(result.stats.lastmodMin).toBeUndefined();
    expect(result.stats.lastmodMax).toBeUndefined();
  });

  it('parses a sitemap index into children', () => {
    const { result, records, lines } = parse(fx('index.xml'));
    expect(result.kind).toBe('sitemapindex');
    expect(records).toHaveLength(0);
    expect(rowsStarting(lines, '<sitemap>')).toEqual([3, 7]);
    expect(result.children).toEqual([
      { loc: 'https://shop.example/sitemap-products.xml', lastmod: '2026-06-01', line: 3 },
      { loc: 'https://shop.example/sitemap-pages.xml', lastmod: undefined, line: 7 },
    ]);
  });

  it('collects hreflang alternates, languages and clusters', () => {
    const { result, records } = parse(fx('hreflang.xml'));
    expect(records[0]!.alternates).toEqual([
      { hreflang: 'en', href: 'https://ml.example/en/p1' }, { hreflang: 'de', href: 'https://ml.example/de/p1' }, { hreflang: 'x-default', href: 'https://ml.example/en/p1' },
    ]);
    expect(records[2]!.alternates).toEqual([{ hreflang: 'en', href: 'https://ml.example/en/p2' }, { hreflang: 'fr', href: 'https://ml.example/fr/p2' }]);
    expect(result.stats.languages.sort()).toEqual(['de', 'en', 'fr', 'x-default']);
    expect(result.stats.clusterCount).toBe(2);
  });

  it('keeps the page <loc> when an <image:loc> follows it', () => {
    const { records } = parse(fx('images.xml'));
    expect(records[0]!.loc).toBe('https://shop.example/en/generators/16925-keel-cooled.html');
    expect(records[1]!.loc).toBe('https://shop.example/en/seabob/5029-seabob-f5-s.html');
  });

  it('counts image:image blocks per url', () => {
    const { result, records } = parse(fx('images.xml'));
    expect(records.map((r) => r.images)).toEqual([1, 3, undefined]);
    expect(result.stats.imageCount).toBe(4);
  });

  it('still reads sitemap fields when the sitemap namespace itself carries a prefix', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      '<sm:url><sm:loc>https://a.com/p</sm:loc><sm:lastmod>2026-05-01</sm:lastmod>',
      '<image:image><image:loc>https://a.com/p.jpg</image:loc></image:image></sm:url>',
      '</sm:urlset>',
    ].join('\n');
    const { result, records } = parse(xml);
    expect(records).toEqual([{ loc: 'https://a.com/p', line: 3, lastmod: '2026-05-01', images: 1 }]);
    expect(result.issues).toEqual([]);
  });

  it('flags a prefixed root bound to the wrong namespace', () => {
    const { result } = parse('<sm:urlset xmlns:sm="http://example.com/other"><sm:url><sm:loc>https://a.com/</sm:loc></sm:url></sm:urlset>');
    expect(result.issues).toEqual([{
      code: 'namespace', detail: 'wrong-namespace', line: 1, params: { attr: 'xmlns:sm', value: 'http://example.com/other', expected: 'http://www.sitemaps.org/schemas/sitemap/0.9' },
      message: 'root xmlns:sm is "http://example.com/other", expected "http://www.sitemaps.org/schemas/sitemap/0.9"',
    }]);
  });

  it('reports structural issues and still extracts what it can', () => {
    const { result, records } = parse(fx('broken.xml'));
    expect(result.issues).toEqual([
      {
        code: 'namespace', detail: 'wrong-namespace', line: 2, params: { attr: 'xmlns', value: '', expected: 'http://www.sitemaps.org/schemas/sitemap/0.9' },
        message: 'root xmlns is "", expected "http://www.sitemaps.org/schemas/sitemap/0.9"',
      },
      { code: 'loc-missing', detail: 'url-without-loc', line: 3, params: {}, message: 'url entry has no <loc>' },
    ]);
    expect(records.map((r) => r.loc)).toEqual(['https://b.example/ok', 'relative/path', 'https://b.example/dup', 'https://b.example/dup', 'https://other-host.example/x']); // every url that had a loc
    expect(result.stats.duplicateCount).toBe(1);
  });

  it('keeps 20 loc-missing issues, drops the 21st, and keeps no records on large broken input', () => {
    const issuesFor = (n: number) => {
      const urls = Array.from({ length: n }, () => '<url><lastmod>2026-01-01</lastmod></url>').join('');
      const { result, records } = parse(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
      expect(records).toHaveLength(0);
      return result.issues.filter((i) => i.code === 'loc-missing').length;
    };
    expect(issuesFor(19)).toBe(19);
    expect(issuesFor(20)).toBe(20);
    expect(issuesFor(21)).toBe(20);
    expect(issuesFor(50)).toBe(20);
  });

  it('flags a non-sitemap root', () => {
    const { result, lines } = parse(fx('not-sitemap.html'));
    expect(result.kind).toBe('unknown');
    expect(lineOf(lines, '<html>')).toBe(2); // after the DOCTYPE row
    expect(result.issues).toEqual([{
      code: 'root-element', detail: 'wrong-root', line: 2, params: { tag: 'html' }, message: 'root element is <html>, expected <urlset> or <sitemapindex>',
    }]);
  });

  it('treats self-closing <url/> and <loc/> as empty instead of leaking parse state', () => {
    const { result, records } = parse(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url/><url><loc/></url><url><loc>https://a.com/ok</loc></url></urlset>',
    );
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/ok']);
    expect(result.issues.map((i) => [i.code, i.detail])).toEqual([['loc-missing', 'url-without-loc'], ['loc-missing', 'url-without-loc']]);
  });

  it('ignores self-closed <sitemap/> entries in an index', () => {
    const { result } = parse(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap/><sitemap><loc>https://a.com/c.xml</loc></sitemap></sitemapindex>',
    );
    expect(result.children.map((c) => c.loc)).toEqual(['https://a.com/c.xml']);
  });

  describe('url cap', () => {
    const NSU = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
    // one write per entry, so the cap is checked between them
    const fed = (root: 'urlset' | 'sitemapindex', n: number) => {
      const records: UrlRecord[] = [];
      const p = new SitemapParser({ onRecords: (r) => records.push(...r) }, 2000, { maxUrls: 5 });
      p.write(`<${root} ${NSU}>`);
      const over: boolean[] = [];
      for (let i = 0; i < n; i++) {
        p.write(root === 'urlset' ? `<url><loc>https://a.com/${i}</loc></url>` : `<sitemap><loc>https://a.com/s${i}.xml</loc></sitemap>`);
        over.push(p.overLimit);
      }
      return { over, result: p.finish(), records };
    };

    it('accepts exactly maxUrls urls and stops at the one after, which completes while the rest are dropped', () => {
      const exact = fed('urlset', 5);
      expect(exact.over).toEqual([false, false, false, false, false]);
      expect(exact.result.truncated).toBe(false);
      expect(exact.result.stats.urlCount).toBe(5);
      const over = fed('urlset', 10);
      expect(over.over).toEqual([false, false, false, false, false, true, true, true, true, true]);
      expect(over.result.truncated).toBe(true);
      expect(over.result.stats.urlCount).toBe(6);
      expect(over.records.map((r) => r.loc)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `https://a.com/${i}`));
    });

    it('reports no XML error for the construct the hard stop cut, only parse-truncated', () => {
      const p = new SitemapParser({ onRecords: () => {} }, 2000, { maxUrls: 5 });
      p.write(`<urlset ${NSU}>`);
      for (let i = 0; i < 5; i++) p.write(`<url><loc>https://a.com/${i}</loc></url>`);
      p.write('<url><loc>https://a.com/5</loc></url><url><loc>https://a.com/6</loc></ur'); // the cap trips while a tag is open
      p.write('l></urlset>'); // ignored: past the stop
      const result = p.finish();
      expect(result.truncated).toBe(true);
      expect(result.issues.filter((i) => i.code === 'xml-error')).toEqual([]);
    });

    it('applies the same cap to index children', () => {
      const exact = fed('sitemapindex', 5);
      expect(exact.result.truncated).toBe(false);
      expect(exact.result.children).toHaveLength(5);
      const over = fed('sitemapindex', 10);
      expect(over.over.indexOf(true)).toBe(5);
      expect(over.result.truncated).toBe(true);
      expect(over.result.children.map((c) => c.loc)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `https://a.com/s${i}.xml`));
    });
  });

  describe('byte cap', () => {
    const limited = () => new SitemapParser({ onRecords: () => {} }, 2000, { maxBytes: 100 });

    it('accepts exactly maxBytes bytes and stops at the next one', () => {
      const exact = limited();
      exact.write('x'.repeat(100));
      expect(exact.overLimit).toBe(false);
      expect(exact.finish().truncated).toBe(false);
      const over = limited();
      over.write('x'.repeat(101));
      expect(over.overLimit).toBe(true);
      expect(over.finish().truncated).toBe(true);
    });

    it('stops accepting writes once over', () => {
      const p = limited();
      p.write('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(p.overLimit).toBe(false);
      p.write('x'.repeat(200));
      expect(p.overLimit).toBe(true);
      p.write('<url><loc>https://a.com/late</loc></url></urlset>');
      const result = p.finish();
      expect(result.truncated).toBe(true);
      expect(result.stats.urlCount).toBe(0);
    });
  });

  it('flushes records in batches and emits the formatted rows', () => {
    const text = fx('valid-small.xml');
    const batches: number[] = [];
    const p = new SitemapParser({ onRecords: (r) => batches.push(r.length) }, 2);
    p.write(text); p.finish();
    expect(batches).toEqual([2, 1]);
    const exact: number[] = [];
    const q = new SitemapParser({ onRecords: (r) => exact.push(r.length) }, 3);
    q.write(text); q.finish();
    expect(exact).toEqual([3]); // a batch that fills up exactly is not followed by an empty one
    expect(parse(text).lines).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url>', '    <loc>https://shop.example/</loc>', '    <lastmod>2026-05-01</lastmod>', '    <priority>1.0</priority>', '  </url>',
      '  <url>', '    <loc>https://shop.example/a</loc>', '    <lastmod>2026-05-02T10:00:00Z</lastmod>', '    <changefreq>daily</changefreq>', '  </url>',
      '  <url>', '    <loc>https://shop.example/b?x=1&amp;y=2</loc>', '  </url>',
      '</urlset>',
    ]);
  });

  it('streams 50k urls with bounded flushes', () => {
    const rows = Array.from({ length: 50000 }, (_, i) => `<url><loc>https://big.example/${['a', 'b', 'c', 'd'][i % 4]}/p${i}</loc><lastmod>2026-01-01</lastmod></url>\n`);
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('')}</urlset>\n`;
    let count = 0;
    const batches: number[] = [];
    const p = new SitemapParser({ onRecords: (r) => { count += r.length; batches.push(r.length); } });
    for (let i = 0; i < text.length; i += 65536) p.write(text.slice(i, i + 65536));
    const result = p.finish();
    expect(count).toBe(50000);
    expect(batches).toEqual(Array.from({ length: 25 }, () => 2000));
    expect(result.stats.urlCount).toBe(50000);
    expect(result.stats.topLastmodShare).toBe(1); // all identical lastmod
  });

  describe('well-formedness', () => {
    const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
    const xmlErrors = (text: string) => parse(text).result.issues.filter((i) => i.code === 'xml-error');

    it('reports an empty, whitespace-only or rootless document', () => {
      for (const doc of ['<?xml version="1.0"?>', '<!-- nothing -->']) {
        expect(parse(doc).result.issues, JSON.stringify(doc)).toEqual([{
          code: 'root-element', detail: 'no-root', line: 1, params: {}, message: 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>',
        }]);
      }
      for (const doc of ['', ' \n\t ', '\n', '   \n  ']) { // no XML row exists, so the finding has no line to link to
        const { result, lines } = parse(doc);
        expect(lines, JSON.stringify(doc)).toEqual([]);
        expect(result.issues, JSON.stringify(doc)).toEqual([{
          code: 'root-element', detail: 'no-root', params: {}, message: 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>',
        }]);
      }
      expect(parse('just text').result.issues.map((i) => [i.code, i.detail])).toEqual([['xml-error', 'unterminated-content'], ['root-element', 'no-root']]);
    });

    it('reports a mismatched end tag, and the end tag that no longer matches after it', () => {
      expect(parse(`<urlset ${NS}><url><loc>https://a.com/</lo></url></urlset>`).result.issues).toEqual([
        // rows: <urlset>, <url>, <loc>https://a.com/</lo>, </url>, </urlset>
        { code: 'xml-error', detail: 'close-mismatch', line: 3, params: { tag: 'lo', open: 'loc' }, message: 'closing tag </lo> does not match open <loc>' },
        { code: 'xml-error', detail: 'close-mismatch', line: 4, params: { tag: 'url', open: 'loc' }, message: 'closing tag </url> does not match open <loc>' },
        { code: 'loc-missing', detail: 'url-without-loc', line: 2, params: {}, message: 'url entry has no <loc>' },
      ]);
    });

    it('reports elements left unclosed at EOF (truncated file)', () => {
      const { result, records, lines } = parse(`<urlset ${NS}><url><loc>https://a.com/1</loc></url><url><loc>https://a.com/2</loc></url>`);
      expect(records.map((r) => r.loc)).toEqual(['https://a.com/1', 'https://a.com/2']);
      expect(lines).toHaveLength(7);
      expect(result.issues).toEqual([{
        code: 'xml-error', detail: 'unclosed-elements', line: 7, params: { count: 1, tag: 'urlset' }, // the last row
        message: '1 element left unclosed at end of document, innermost <urlset> (truncated file?)',
      }]);
    });

    it('gives every structural issue a code and params the UI can translate', () => {
      const RESULT_MSG = 'root xmlns is "urn:x", expected "http://www.sitemaps.org/schemas/sitemap/0.9"';
      expect(parse('<html><body/></html>').result.issues[0]).toEqual({
        code: 'root-element', detail: 'wrong-root', line: 1, params: { tag: 'html' }, message: 'root element is <html>, expected <urlset> or <sitemapindex>',
      });
      expect(parse('x').result.issues.at(-1)).toEqual({
        code: 'root-element', detail: 'no-root', line: 1, params: {}, message: 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>',
      });
      expect(xmlErrors(`<urlset ${NS}><url><loc>https://a.com/</lo></url></urlset>`)[0]).toEqual({
        code: 'xml-error', detail: 'close-mismatch', line: 3, params: { tag: 'lo', open: 'loc' }, message: 'closing tag </lo> does not match open <loc>',
      });
      expect(parse(`<urlset ${NS}><url><loc>https://a.com/1</loc></url>`).result.issues).toEqual([{
        code: 'xml-error', detail: 'unclosed-elements', line: 4, params: { count: 1, tag: 'urlset' },
        message: '1 element left unclosed at end of document, innermost <urlset> (truncated file?)',
      }]);
      expect(parse('<urlset xmlns="urn:x"></urlset>').result.issues).toEqual([{
        code: 'namespace', detail: 'wrong-namespace', line: 1, params: { attr: 'xmlns', value: 'urn:x', expected: 'http://www.sitemaps.org/schemas/sitemap/0.9' }, message: RESULT_MSG,
      }]);
      expect(parse(`<urlset ${NS}><url/></urlset>`).result.issues).toEqual([{ code: 'loc-missing', detail: 'url-without-loc', line: 2, params: {}, message: 'url entry has no <loc>' }]);
    });

    it('does not report anything for a complete, balanced document', () => {
      expect(parse(`<urlset ${NS}><url><loc>https://a.com/</loc></url></urlset>\n`).result.issues).toEqual([]);
    });

    it('rejects concatenated roots, entries and text after the root without extracting them', () => {
      const root = `<urlset ${NS}><url><loc>https://a.com/first</loc></url></urlset>`;
      for (const tail of [
        `<urlset ${NS}><url><loc>https://a.com/second</loc></url></urlset>`,
        '<url><loc>https://a.com/second</loc></url>',
        'stray text<!-- end -->',
      ]) {
        const xml = root + tail;
        for (const chunk of [1, 7, xml.length]) {
          const { result, records } = parse(xml, 2000, chunk);
          expect(records.map((r) => r.loc)).toEqual(['https://a.com/first']);
          expect(result.issues.map((i) => [i.code, i.detail, i.params, i.message])).toEqual([
            ['xml-error', 'content-after-root', {}, 'unexpected content after the root element'],
          ]);
        }
      }
    });

    it('rejects index entries after a closed or self-closed root', () => {
      for (const root of [`<sitemapindex ${NS}></sitemapindex>`, `<sitemapindex ${NS}/>`]) {
        const xml = `${root}<sitemap><loc>https://a.com/second.xml</loc></sitemap>`;
        for (const chunk of [1, 7, xml.length]) {
          const { result } = parse(xml, 2000, chunk);
          expect(result.children).toEqual([]);
          expect(result.issues.map((i) => i.detail)).toEqual(['content-after-root']);
        }
      }
    });

    it('accepts whitespace, comments and processing instructions after the root', () => {
      const xml = `<urlset ${NS}/><!-- end -->\n<?done?>\t`;
      for (const chunk of [1, 7, xml.length]) expect(parse(xml, 2000, chunk).result.issues).toEqual([]);
      const p = new SitemapParser({ onRecords: () => {} });
      p.write(`<urlset ${NS}></urlset>`);
      p.write('\n \t\r\n');
      expect(p.finish().issues).toEqual([]);
      expect(xmlErrors(`<urlset ${NS}/>stray text`).map((i) => i.detail)).toEqual(['unterminated-content']);
    });

    it('does not silently drop an unclosed <url> that is followed by another <url>', () => {
      const { result, records } = parse(`<urlset ${NS}><url><loc>https://a.com/1</loc><url><loc>https://a.com/2</loc></url></urlset>`);
      expect(result.issues.map((i) => [i.code, i.detail, i.message])).toEqual([
        ['xml-error', 'url-not-closed', '<url> opened at line 4 before the <url> from line 2 was closed'], // the second <url> nests under the first's <loc> row
        ['xml-error', 'close-mismatch', 'closing tag </urlset> does not match open <url>'],
      ]);
      expect(records.map((r) => r.loc)).toEqual(['https://a.com/1', 'https://a.com/2']);
    });

    it('keeps the depth stack bounded and balanced past the cap', () => {
      for (const depth of [63, 64, 65, 200]) {
        const deep = '<g>'.repeat(depth) + '</g>'.repeat(depth);
        expect(parse(`<urlset ${NS}>${deep}</urlset>`).result.issues, `depth ${depth}`).toEqual([]);
      }
    });

    it('still reports elements left unclosed when they nest past the depth cap', () => {
      const issues = parse(`<urlset ${NS}>${'<g>'.repeat(200)}`).result.issues;
      expect(issues.map((i) => [i.detail, i.params])).toEqual([['unclosed-elements', { count: 201, tag: 'g' }]]);
    });

    it('stays quiet about nesting when the root is not a sitemap', () => {
      const { result } = parse('<html><body><br><p>x</body></html>');
      expect(result.issues.map((i) => i.code)).toEqual(['root-element']);
    });
  });

  describe('bounded accumulators', () => {
    const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"';
    const feed = (text: string, chunk = 65536) => {
      const records: UrlRecord[] = [];
      const p = new SitemapParser({ onRecords: (r) => records.push(...r) });
      for (let i = 0; i < text.length; i += chunk) p.write(text.slice(i, i + chunk));
      return { result: p.finish(), records };
    };

    it('keeps a <loc> of 8,192 chars whole and cuts a longer one to 8,192 (still detectably too long)', () => {
      const locOf = (n: number) => feed(`<urlset ${NS}><url><loc>${'x'.repeat(n)}</loc></url></urlset>`).records[0]!.loc;
      expect(locOf(8191)).toBe('x'.repeat(8191));
      expect(locOf(8192)).toBe('x'.repeat(8192));
      expect(locOf(8193)).toBe('x'.repeat(8192));
      expect(`https://a.com/${'x'.repeat(5_000_000)}`.slice(0, 8192)).toBe(feed(`<urlset ${NS}><url><loc>https://a.com/${'x'.repeat(5_000_000)}</loc></url></urlset>`).records[0]!.loc);
    });

    it('keeps the first 500 alternates of a record and drops the rest', () => {
      const alternatesOf = (n: number) => {
        const links = Array.from({ length: n }, (_, i) => `<xhtml:link rel="alternate" hreflang="l${i}" href="https://a.com/${i}"/>`).join('');
        return feed(`<urlset ${NS}><url><loc>https://a.com/</loc>${links}</url></urlset>`).records[0]!.alternates!;
      };
      const want = (n: number) => Array.from({ length: n }, (_, i) => ({ hreflang: `l${i}`, href: `https://a.com/${i}` }));
      expect(alternatesOf(499)).toEqual(want(499));
      expect(alternatesOf(500)).toEqual(want(500));
      expect(alternatesOf(501)).toEqual(want(500));
      expect(alternatesOf(800)).toEqual(want(500));
    });

    it('keeps the first 1000 distinct languages and drops the rest', () => {
      const languagesOf = (n: number) => {
        const urls = Array.from({ length: n }, (_, i) => `<url><loc>https://a.com/${i}</loc><xhtml:link rel="alternate" hreflang="l${i}" href="https://a.com/${i}"/></url>`).join('');
        return feed(`<urlset ${NS}>${urls}</urlset>`).result.stats.languages;
      };
      const want = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
      expect(languagesOf(999)).toEqual(want(999));
      expect(languagesOf(1000)).toEqual(want(1000));
      expect(languagesOf(1001)).toEqual(want(1000));
      expect(languagesOf(1500)).toEqual(want(1000));
    });

    it('tracks 100 xmlns prefixes and ignores the declarations after them', () => {
      const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9';
      const only = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
      const locViaLastOf = (n: number) => {
        const decl = Array.from({ length: n }, (_, i) => `xmlns:p${i}="${i === n - 1 ? ns : 'urn:x'}"`).join(' ');
        return feed(`<urlset ${only} ${decl}><url><p${n - 1}:loc>https://a.com/last</p${n - 1}:loc></url></urlset>`).records.map((r) => r.loc);
      };
      expect(locViaLastOf(99)).toEqual(['https://a.com/last']);
      expect(locViaLastOf(100)).toEqual(['https://a.com/last']); // the 100th prefix is still tracked
      expect(locViaLastOf(101)).toEqual([]); // the 101st is not
      expect(locViaLastOf(150)).toEqual([]);
    });

    it('keeps counting known lastmod values past the distinct cap instead of zeroing the share', () => {
      const urls = Array.from({ length: 2000 }, (_, i) => `<url><loc>https://a.com/${i}</loc><lastmod>${i % 2 ? `2020-01-01T00:00:00.${String(i).padStart(4, '0')}Z` : '2026-01-01'}</lastmod></url>`).join('');
      const { result } = feed(`<urlset ${NS}>${urls}</urlset>`);
      expect(result.stats.topLastmodShare).toBe(0.5);
    });

    it('compares lastmod min/max by instant, not lexically, and skips invalid dates', () => {
      const lm = (v: string) => `<url><loc>https://a.com/${encodeURIComponent(v)}</loc><lastmod>${v}</lastmod></url>`;
      const { result } = feed(`<urlset ${NS}>${['2026-05-01T23:00:00-05:00', '2026-05-02', '2026-05-01T12:00:00Z', 'not-a-date'].map(lm).join('')}</urlset>`);
      expect(result.stats.lastmodMin).toBe('2026-05-01T12:00:00Z');
      expect(result.stats.lastmodMax).toBe('2026-05-01T23:00:00-05:00');
    });

    it('counts byteSize in UTF-8 bytes, including surrogate pairs split across chunks', () => {
      const text = `<urlset ${NS}><url><loc>https://a.com/é€😀</loc></url></urlset>`;
      expect(parse(text, 2000, 1).result.stats.byteSize).toBe(Buffer.byteLength(text));
      expect(parse(text).result.stats.byteSize).toBe(Buffer.byteLength(text));
    });

    it('applies the byte cap to bytes, not UTF-16 units', () => {
      const overAfter = (euros: number) => {
        const p = new SitemapParser({ onRecords: () => {} }, 2000, { maxBytes: 100 });
        p.write('€'.repeat(euros)); // 3 bytes each
        return p.overLimit;
      };
      expect(overAfter(33)).toBe(false); // 99 bytes in 33 units
      expect(overAfter(34)).toBe(true); // 102 bytes in 34 units
    });

    it('splits a newline-free body into lines in linear time', () => {
      let calls = 0;
      let scanned = 0;
      const original = String.prototype.indexOf;
      const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, ...args: Parameters<string['indexOf']>) {
        scanned += this.length - (args[1] ?? 0);
        return original.apply(this, args);
      });
      try {
        const p = new SitemapParser({ onRecords: () => {}, onLines: () => { calls++; } });
        for (let i = 0; i < 4000; i++) p.write('x'.repeat(1000));
        p.finish();
      } finally { spy.mockRestore(); }
      expect(scanned).toBeLessThanOrEqual(4 * 4000 * 1000); // each character is searched a bounded number of times, not once per later chunk
      expect(calls).toBe(1);
    });

    it('survives hundreds of thousands of lines in one chunk', () => {
      let total = 0;
      const p = new SitemapParser({ onRecords: () => {}, onLines: (l) => { total += l.length; } });
      p.write(`<urlset ${NS}><!--` + '\n'.repeat(400_000) + '--></urlset>');
      p.finish();
      expect(total).toBe(400_003); // <urlset>, the comment's first row and one per line break, </urlset>
    });
  });

  describe('extension namespaces', () => {
    const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
    const IMG = 'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
    const MOB = 'xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0"';
    const collect = (xml: string, flushSize = 2000, chunkSize = xml.length || 1) => {
      const batches: { records: UrlRecord[]; ext: ExtensionHit[] }[] = [];
      const lines: string[] = [];
      const p = new SitemapParser({ onRecords: (records, ext) => batches.push({ records: [...records], ext: [...ext] }), onLines: (l) => lines.push(...l) }, flushSize);
      for (let i = 0; i < xml.length; i += chunkSize) p.write(xml.slice(i, i + chunkSize));
      return { result: p.finish(), batches, lines };
    };

    it('reports deprecated image tags and mobile tags once per url, indexed to their record', () => {
      const xml = [
        `<urlset ${NS} ${IMG} ${MOB}>`,
        '<url><loc>https://a.com/1</loc></url>',
        '<url><loc>https://a.com/2</loc>',
        '<image:image><image:loc>https://a.com/a.jpg</image:loc><image:caption>A</image:caption></image:image>',
        '<image:image><image:loc>https://a.com/b.jpg</image:loc><image:caption>B</image:caption><image:license>x</image:license></image:image>',
        '<mobile:mobile/></url>',
        '</urlset>',
      ].join('\n');
      const { batches, lines } = collect(xml);
      const expected = [
        { recordIx: 1, rule: 'image-deprecated-field', line: lineOf(lines, '<image:caption>A'), value: 'image:caption' },
        { recordIx: 1, rule: 'image-deprecated-field', line: lineOf(lines, '<image:license>'), value: 'image:license' },
        { recordIx: 1, rule: 'mobile-obsolete', line: lineOf(lines, '<mobile:mobile/>') },
      ];
      expect(expected.map((h) => h.line)).toEqual([9, 14, 16]);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.records.map((r) => r.images)).toEqual([undefined, 2]);
      expect(batches[0]!.ext).toEqual(expected);
      // the same fixture fed in 7-char chunks, so tags and text straddle write boundaries
      const chunked = collect(xml, 2000, 7);
      expect(chunked.batches[0]!.records.map((r) => r.images)).toEqual([undefined, 2]);
      expect(chunked.batches[0]!.ext).toEqual(expected);
    });

    it('ignores extension tags whose prefix is bound to another namespace, and unbound prefixes', () => {
      const xml = `<urlset ${NS} xmlns:image="https://example.com/not-google"><url><loc>https://a.com/1</loc>`
        + '<image:image><image:loc>https://a.com/a.jpg</image:loc><image:title>T</image:title></image:image><mobile:mobile/></url></urlset>';
      const { batches } = collect(xml);
      expect(batches[0]!.ext).toEqual([]);
      expect(batches[0]!.records[0]!.images).toBeUndefined(); // images count by namespace URI too
    });

    it('counts images by namespace URI, whatever the prefix', () => {
      const xml = `<urlset ${NS} xmlns:pic="http://www.google.com/schemas/sitemap-image/1.1" xmlns:image="https://example.com/not-google"><url><loc>https://a.com/1</loc>`
        + '<pic:image><pic:loc>https://a.com/a.jpg</pic:loc></pic:image><pic:image><pic:loc>https://a.com/b.jpg</pic:loc></pic:image>'
        + '<image:image><image:loc>https://a.com/c.jpg</image:loc></image:image></url></urlset>';
      const { batches } = collect(xml);
      expect(batches[0]!.records[0]!.images).toBe(2);
    });

    it('drops hits of a url without <loc> and keeps record indexes right across flushes', () => {
      const urls = [
        '<url><mobile:mobile/></url>',
        '<url><loc>https://a.com/1</loc></url>',
        '<url><loc>https://a.com/2</loc><mobile:mobile/></url>',
        '<url><loc>https://a.com/3</loc><mobile:mobile/></url>',
      ];
      const { batches } = collect(`<urlset ${NS} ${MOB}>${urls.join('')}</urlset>`, 2);
      expect(batches.map((b) => b.records.map((r) => r.loc))).toEqual([['https://a.com/1', 'https://a.com/2'], ['https://a.com/3']]);
      expect(batches.map((b) => b.ext.map((h) => h.recordIx))).toEqual([[1], [0]]);
    });
  });

  describe('news blocks', () => {
    const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"';
    const NOW = Date.parse('2026-08-27T12:00:00Z');
    const hitsOf = (body: string, chunkSize = 0) => {
      const ext: ExtensionHit[] = [];
      const p = new SitemapParser({ onRecords: (_records, e) => { ext.push(...e); } }, 2000, {}, NOW);
      const xml = `<urlset ${NS}>\n${body}\n</urlset>`;
      if (chunkSize) for (let i = 0; i < xml.length; i += chunkSize) p.write(xml.slice(i, i + chunkSize));
      else p.write(xml);
      return { ext, result: p.finish() };
    };
    const block = (inner: string) => `<url><loc>https://a.com/n</loc><news:news>${inner}</news:news></url>`;
    const FULL = '<news:publication><news:name>Daily</news:name><news:language>en</news:language></news:publication>'
      + '<news:publication_date>2026-08-26T09:00:00Z</news:publication_date><news:title>Big &amp; <![CDATA[small]]></news:title>';

    it('accepts a complete, fresh block and counts it', () => {
      const { ext, result } = hitsOf(block(FULL));
      expect(ext).toEqual([]);
      expect(result.stats.newsCount).toBe(1);
    });

    it('reports each missing or empty required tag, with the block line', () => {
      const { ext } = hitsOf(block('<news:publication><news:name> </news:name></news:publication>'));
      expect(ext.map((h) => [h.rule, h.value, h.line])).toEqual([
        // rows: <urlset>, <url>, <loc>, <news:news>
        ['news-missing-field', 'news:name', 4], ['news-missing-field', 'news:language', 4],
        ['news-missing-field', 'news:publication_date', 4], ['news-missing-field', 'news:title', 4],
      ]);
    });

    it('checks the language, accepting zh-cn and zh-tw in any case', () => {
      const rules = (v: string) => hitsOf(block(FULL.replace('<news:language>en<', `<news:language>${v}<`))).ext.map((h) => h.rule);
      for (const ok of ['en', 'EN', 'zh-cn', 'ZH-TW', 'fil']) expect(rules(ok), ok).toEqual([]);
      for (const bad of ['english', 'zz', 'en-us', 'zh-hk']) expect(rules(bad), bad).toEqual(['news-invalid-language']);
    });

    it('errors on a non-W3C or incomplete date and warns on one more than two days before the scan', () => {
      const date = (v: string) => hitsOf(block(FULL.replace('2026-08-26T09:00:00Z', v))).ext.map((h) => [h.rule, h.value]);
      expect(date('26 Aug 2026')).toEqual([['news-invalid-date', '26 Aug 2026']]);
      expect(date('2026')).toEqual([['news-invalid-date', '2026']]);
      expect(date('2026-08')).toEqual([['news-invalid-date', '2026-08']]);
      expect(date('2026-08-25T11:59:59Z')).toEqual([['news-too-old', '2026-08-25T11:59:59Z']]);
      expect(date('2026-08-25T12:00:00Z')).toEqual([]);
      expect(date('2026-08-26')).toEqual([]);
    });

    it('keeps only the capped example length of a huge news value', () => {
      const { ext } = hitsOf(block(FULL.replace('<news:language>en<', `<news:language>${'x'.repeat(100_000)}<`)));
      expect(ext.map((h) => [h.rule, h.value])).toEqual([['news-invalid-language', 'x'.repeat(EXAMPLE_MAX) + '…']]);
    });

    it('checks a block left open when its url ends, and a self-closed block', () => {
      const { ext, result } = hitsOf([
        `<url><loc>https://a.com/1</loc><news:news>${FULL}</url>`,
        '<url><loc>https://a.com/2</loc><news:news/></url>',
      ].join('\n'));
      expect(result.stats.newsCount).toBe(2);
      expect(ext.filter((h) => h.recordIx === 0)).toEqual([]);
      expect(ext.filter((h) => h.recordIx === 1).map((h) => h.value)).toEqual(['news:publication', 'news:name', 'news:language', 'news:publication_date', 'news:title']);
    });

    it('closes an open block when the next <url> starts before </url>', () => {
      const { ext } = hitsOf('<url><loc>https://a.com/1</loc><news:news><news:title>T</news:title>\n<url><loc>https://a.com/2</loc></url>');
      expect(ext.map((h) => [h.recordIx, h.value])).toEqual([
        [0, 'news:publication'], [0, 'news:name'], [0, 'news:language'], [0, 'news:publication_date'],
      ]);
    });

    it('ignores news tags outside a <url>', () => {
      const { ext, result } = hitsOf('<news:news><news:title>T</news:title></news:news><url><loc>https://a.com/1</loc></url>');
      expect(ext).toEqual([]);
      expect(result.stats.newsCount).toBe(0);
    });

    it('reads the same hits when the fixture arrives in 7-char chunks', () => {
      const body = [
        block(FULL.replace('>en<', '>english<').replace('2026-08-26T09:00:00Z', '2026-08-01')),
        block(FULL.replace('<news:title>', '<news:title> ').replace('2026-08-26T09:00:00Z', '2026-08')),
        '<url><loc>https://a.com/3</loc><news:news/></url>',
      ].join('\n');
      const whole = hitsOf(body);
      expect(whole.ext.map((h) => [h.recordIx, h.rule, h.value])).toEqual([
        [0, 'news-invalid-language', 'english'], [0, 'news-too-old', '2026-08-01'], [1, 'news-invalid-date', '2026-08'],
        [2, 'news-missing-field', 'news:publication'], [2, 'news-missing-field', 'news:name'], [2, 'news-missing-field', 'news:language'],
        [2, 'news-missing-field', 'news:publication_date'], [2, 'news-missing-field', 'news:title'],
      ]);
      const chunked = hitsOf(body, 7);
      expect(chunked.ext).toEqual(whole.ext);
      expect(chunked.result.stats.newsCount).toBe(3);
    });
  });

  describe('video blocks', () => {
    const NSV = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';
    const hitsOf = (body: string, chunkSize = 0) => {
      const ext: ExtensionHit[] = [];
      const p = new SitemapParser({ onRecords: (_records, e) => { ext.push(...e); } }, 2000, {}, 0);
      const xml = `<urlset ${NSV}>${body}</urlset>`;
      if (chunkSize) for (let i = 0; i < xml.length; i += chunkSize) p.write(xml.slice(i, i + chunkSize));
      else p.write(xml);
      return { ext, result: p.finish() };
    };
    const BODY = '<url><loc>https://a.com/v</loc><video:video>'
      + '<video:thumbnail_loc>https://a.com/t.jpg</video:thumbnail_loc><video:title><![CDATA[A & B]]></video:title>'
      + '<video:description>D</video:description><video:player_loc>https://a.com/p</video:player_loc><video:duration>0</video:duration>'
      + '<video:category>Demos</video:category></video:video><video:video/></url>';

    it('counts video blocks, reads CDATA values and checks a self-closed video', () => {
      const { ext, result } = hitsOf(BODY);
      expect(result.stats.videoCount).toBe(2);
      expect(ext.map((h) => [h.rule, h.value])).toEqual([
        ['video-invalid-value', '<video:duration>: "0"'],
        ['video-deprecated-field', 'video:category'],
        ['video-missing-field', 'video:thumbnail_loc'], ['video-missing-field', 'video:title'],
        ['video-missing-field', 'video:description'], ['video-missing-field', 'video:content_loc / video:player_loc'],
      ]);
    });

    it('reads the same hits when the fixture arrives in 7-char chunks', () => {
      expect(hitsOf(BODY, 7)).toEqual(hitsOf(BODY));
    });

    it('reports the length of a huge description up to the tokenizer text-run cap', () => {
      const { ext } = hitsOf(BODY.replace('>D<', `>${'d'.repeat(100_000)}<`)); // reported on the <video:video> row, 4
      expect(ext.find((h) => h.rule === 'video-invalid-value')).toEqual({
        recordIx: 0, rule: 'video-invalid-value', line: 4, value: '<video:description> is 65,536 characters (limit 2,048)',
        code: 'ext-too-long', params: { field: 'video:description', length: 65_536, max: 2048 },
      });
    });
  });

  describe('block counts across batch flushes', () => {
    const NSB = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';
    const run = (urls: string[], flushSize: number) => {
      const batches: { records: number; ext: ExtensionHit[] }[] = [];
      const p = new SitemapParser({ onRecords: (records, ext) => { batches.push({ records: records.length, ext: [...ext] }); } }, flushSize, {}, 0);
      p.write(`<urlset ${NSB}>${urls.join('')}</urlset>`);
      return { batches, result: p.finish() };
    };
    const COUNT = 1001; // one over MAX_NEWS_PER_SITEMAP

    it('counts news blocks over many flushes, so the 1,000-per-sitemap rule sees the whole sitemap', () => {
      const urls = Array.from({ length: COUNT }, (_, i) => `<url><loc>https://a.com/n${i}</loc><news:news/></url>`);
      const { batches, result } = run(urls, 100);
      expect(batches.map((b) => b.records)).toEqual([...Array.from({ length: 10 }, () => 100), 1]);
      expect(result.stats.newsCount).toBe(COUNT);
      const v = new ValidationRun({
        origin: 'https://a.com', sitemapUrl: 'https://a.com/s.xml', finalUrl: 'https://a.com/s.xml', redirected: false,
        robots: { found: false, url: 'https://a.com/robots.txt', sitemapUrls: [] }, now: 0,
      });
      expect(v.finish(result).find((f) => f.ruleId === 'news-too-many')).toMatchObject({
        severity: 'error', count: 1, examples: [{ value: '1,001 <news:news> elements (limit 1,000)', code: 'ext-too-many' }],
      });
    });

    it('keeps each batch hit pointed at its own record and counts videos over flushes', () => {
      const urls = Array.from({ length: 7 }, (_, i) => `<url><loc>https://a.com/v${i}</loc><video:video/></url>`);
      const { batches, result } = run(urls, 3);
      expect(batches.map((b) => b.records)).toEqual([3, 3, 1]);
      expect(batches.map((b) => [...new Set(b.ext.map((h) => h.recordIx))])).toEqual([[0, 1, 2], [0, 1, 2], [0]]);
      expect(result.stats.videoCount).toBe(7);
    });
  });

  it('matches extension namespaces by uri, whatever the prefix, across write boundaries', () => {
    const xml = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:img="http://www.google.com/schemas/sitemap-image/1.1">\n'
      + '<url><loc>https://a.com/1</loc><img:image><img:loc>https://a.com/a.jpg</img:loc><img:caption>A</img:caption></img:image></url>\n</urlset>';
    const ext: ExtensionHit[] = [];
    const p = new SitemapParser({ onRecords: (_records, e) => { ext.push(...e); } });
    for (let i = 0; i < xml.length; i += 7) p.write(xml.slice(i, i + 7));
    p.finish();
    expect(ext).toEqual([{ recordIx: 0, rule: 'image-deprecated-field', line: 6, value: 'image:caption' }]); // urlset, url, loc, img:image, img:loc, img:caption
  });
});

describe('SitemapParser structure rules', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const XH = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"';

  it('keeps the first of a repeated <loc>, <lastmod>, <changefreq> or <priority> and reports each repeat', () => {
    const xml = `<urlset ${NS}><url><loc>https://a.com/first</loc><loc>https://a.com/second</loc><lastmod>2026-01-01</lastmod><lastmod>2026-02-02</lastmod>`
      + '<changefreq>daily</changefreq><changefreq>weekly</changefreq><priority>0.5</priority><priority>0.9</priority></url></urlset>';
    for (const chunk of [7, 1, xml.length]) {
      const { result, records } = parse(xml, 2000, chunk);
      expect(records).toHaveLength(1);
      expect(records).toEqual([{ loc: 'https://a.com/first', line: 2, lastmod: '2026-01-01', changefreq: 'daily', priority: '0.5' }]);
      expect(result.issues.filter((i) => i.code === 'duplicate-field').map((i) => [i.detail, i.params, i.message])).toEqual(
        ['loc', 'lastmod', 'changefreq', 'priority'].map((field) => ['duplicate-field', { field }, `<${field}> appears more than once in one entry; only the first is used`]),
      );
    }
  });

  it('does not let a default-namespace <image><loc> replace the page URL', () => {
    const { result, records } = parse(`<urlset ${NS}><url><loc>https://a.com/page</loc><image><loc>https://a.com/i.jpg</loc></image></url></urlset>`);
    expect(records[0]!.loc).toBe('https://a.com/page');
    expect(result.issues.map((i) => [i.code, i.params])).toEqual([['duplicate-field', { field: 'loc' }]]);
  });

  it('treats a repeat inside an index <sitemap> the same way, and a new entry starts clean', () => {
    const { result } = parse(`<sitemapindex ${NS}><sitemap><loc>https://a.com/1.xml</loc><loc>https://a.com/x.xml</loc><lastmod>2026-01-01</lastmod><lastmod>2026-03-03</lastmod></sitemap><sitemap><loc>https://a.com/2.xml</loc></sitemap></sitemapindex>`);
    expect(result.children).toEqual([{ loc: 'https://a.com/1.xml', lastmod: '2026-01-01', line: 2 }, { loc: 'https://a.com/2.xml', lastmod: undefined, line: 8 }]);
    expect(result.issues.filter((i) => i.code === 'duplicate-field').map((i) => i.params)).toEqual([{ field: 'loc' }, { field: 'lastmod' }]);
  });

  it('reports <url> inside a sitemapindex and <sitemap> inside a urlset, and drops them', () => {
    const idx = parse(`<sitemapindex ${NS}><url><loc>https://a.com/p</loc></url><sitemap><loc>https://a.com/s.xml</loc></sitemap></sitemapindex>`);
    expect(idx.result.children.map((c) => c.loc)).toEqual(['https://a.com/s.xml']);
    expect(idx.records).toHaveLength(0);
    expect(idx.result.issues).toEqual([{
      code: 'wrong-entry-kind', detail: 'wrong-entry-kind', line: 2, params: { found: 'url', root: 'sitemapindex' },
      message: '<url> entry inside <sitemapindex> is ignored; use <url> in a <urlset> and <sitemap> in a <sitemapindex>',
    }]);
    const set = parse(`<urlset ${NS}><sitemap><loc>https://a.com/s.xml</loc></sitemap><url><loc>https://a.com/p</loc></url></urlset>`);
    expect(set.result.children).toEqual([]);
    expect(set.records.map((r) => r.loc)).toEqual(['https://a.com/p']);
    expect(set.result.issues).toEqual([{
      code: 'wrong-entry-kind', detail: 'wrong-entry-kind', line: 2, params: { found: 'sitemap', root: 'urlset' },
      message: '<sitemap> entry inside <urlset> is ignored; use <url> in a <urlset> and <sitemap> in a <sitemapindex>',
    }]);
  });

  it('reports an index <sitemap> without a <loc>, empty, self-closed or missing', () => {
    const { result, lines } = parse(`<sitemapindex ${NS}>\n<sitemap/>\n<sitemap><lastmod>2026-01-01</lastmod></sitemap>\n<sitemap><loc></loc></sitemap>\n<sitemap><loc>https://a.com/ok.xml</loc></sitemap></sitemapindex>`);
    expect(result.children.map((c) => c.loc)).toEqual(['https://a.com/ok.xml']);
    expect(rowsStarting(lines, '<sitemap')).toEqual([1, 2, 3, 6, 9]); // the root, then each entry
    expect(result.issues.map((i) => [i.code, i.detail, i.line, i.message])).toEqual([2, 3, 6].map((line) => ['loc-missing', 'sitemap-without-loc', line, 'sitemap entry has no <loc>']));
  });

  it('reports an entry nested in an unknown element and text directly under the root, and keeps the entry', () => {
    const { result, records } = parse(`<urlset ${NS}>stray text<wrap><url><loc>https://a.com/n</loc></url></wrap><url><loc>https://a.com/ok</loc></url>\n</urlset>`);
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/n', 'https://a.com/ok']);
    expect(result.issues.map((i) => [i.code, i.params])).toEqual([['misplaced-element', { parent: 'urlset' }], ['misplaced-element', { parent: 'wrap' }]]);
    expect(result.issues[1]!.message).toBe('unexpected entry or text inside <wrap>; entries belong directly under the root element');
  });

  it('reports a missing </url> once and does not call the entries after it misplaced', () => {
    const { result, records, lines } = parse(`<urlset ${NS}><url><loc>https://a.com/1</loc>\n<url><loc>https://a.com/2</loc></url>\n<url><loc>https://a.com/3</loc></url>\n<url><loc>https://a.com/4</loc></url></urlset>`);
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4']);
    // the second <url> opens on the row before its <loc>; </urlset> is the last row
    expect(result.issues.map((i) => [i.detail, i.line])).toEqual([['url-not-closed', lineOf(lines, '>https://a.com/2<') - 1], ['close-mismatch', lines.length]]);
  });

  it('reports a missing </sitemap> once and does not call the entries after it misplaced', () => {
    const { result } = parse(`<sitemapindex ${NS}><sitemap><loc>https://a.com/1.xml</loc>\n<sitemap><loc>https://a.com/2.xml</loc></sitemap>\n<sitemap><loc>https://a.com/3.xml</loc></sitemap></sitemapindex>`);
    expect(result.children.map((c) => c.loc)).toEqual(['https://a.com/2.xml', 'https://a.com/3.xml']);
    expect(result.issues.map((i) => i.detail)).toEqual(['close-mismatch']);
  });

  it('still reports an entry inside a wrapper that follows a closed entry', () => {
    const { result } = parse(`<urlset ${NS}><url><loc>https://a.com/1</loc></url><wrap><url><loc>https://a.com/2</loc></url></wrap></urlset>`);
    expect(result.issues.map((i) => [i.detail, i.params])).toEqual([['misplaced-element', { parent: 'wrap' }]]);
  });

  it('does not call text inside entries, whitespace or comments misplaced', () => {
    const { result } = parse(`<?xml version="1.0"?>\n<urlset ${NS}>\n <!-- c -->\n <url>\n  <loc>https://a.com/</loc>\n </url>\n</urlset>\n`);
    expect(result.issues).toEqual([]);
  });

  it('does not count a link outside the xhtml namespace as an hreflang alternate', () => {
    const xml = `<urlset ${NS} ${XH} xmlns:bad="http://example.com/x"><url><loc>https://a.com/</loc>\n`
      + '<xhtml:link rel="alternate" hreflang="de" href="https://a.com/de"/>\n'
      + '<link rel="alternate" hreflang="fr" href="https://a.com/fr"/>\n'
      + '<bad:link rel="alternate" hreflang="es" href="https://a.com/es"/>\n'
      + '<link xmlns="http://www.w3.org/1999/xhtml" rel="alternate" hreflang="it" href="https://a.com/it"/></url></urlset>';
    const { result, records, lines } = parse(xml);
    expect(records[0]!.alternates).toEqual([{ hreflang: 'de', href: 'https://a.com/de' }, { hreflang: 'it', href: 'https://a.com/it' }]);
    expect(result.stats.languages.sort()).toEqual(['de', 'it']);
    expect([lineOf(lines, 'hreflang="fr"'), lineOf(lines, 'hreflang="es"')]).toEqual([5, 6]);
    expect(result.issues.map((i) => [i.code, i.line, i.params])).toEqual([['alternate-wrong-namespace', 5, { name: 'link' }], ['alternate-wrong-namespace', 6, { name: 'bad:link' }]]);
    expect(result.issues[0]!.message).toBe('<link rel="alternate"> is not in the xhtml namespace (http://www.w3.org/1999/xhtml), so it is not read as an hreflang alternate');
  });

  it('reads a prefixed root with a wrong namespace like an unprefixed one: only the namespace is reported', () => {
    const { result, records } = parse('<sm:urlset xmlns:sm="http://example.com/other"><sm:url><sm:loc>https://a.com/1</sm:loc><sm:lastmod>2026-01-01</sm:lastmod></sm:url></sm:urlset>');
    expect(records).toEqual([{ loc: 'https://a.com/1', lastmod: '2026-01-01', line: 2 }]);
    expect(result.issues.map((i) => i.code)).toEqual(['namespace']);
    const bare = parse('<urlset xmlns="http://example.com/other"><url><loc>https://a.com/1</loc></url></urlset>');
    expect(bare.records.map((r) => r.loc)).toEqual(['https://a.com/1']);
    expect(bare.result.issues.map((i) => i.code)).toEqual(['namespace']);
    const idx = parse('<sm:sitemapindex xmlns:sm="urn:x"><sm:sitemap><sm:loc>https://a.com/s.xml</sm:loc></sm:sitemap></sm:sitemapindex>');
    expect(idx.result.children).toEqual([{ loc: 'https://a.com/s.xml', lastmod: undefined, line: 2 }]);
    expect(idx.result.issues.map((i) => i.code)).toEqual(['namespace']);
  });

  it('ignores foreign and unbound prefixed url and sitemap entries', () => {
    for (const [root, entry] of [['urlset', 'url'], ['sitemapindex', 'sitemap']]) {
      const xml = `<${root} ${NS} xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">`
        + `<bad:${entry} xmlns:bad="urn:other"><loc>https://a.com/foreign</loc></bad:${entry}><bad:${entry}/>`
        + `<unbound:${entry}><loc>https://a.com/unbound</loc></unbound:${entry}><unbound:${entry}/>`
        + `<sm:${entry}><sm:loc>https://a.com/real</sm:loc></sm:${entry}></${root}>`;
      for (const chunk of [1, 7, xml.length]) {
        const { result, records } = parse(xml, 2000, chunk);
        expect([...records, ...result.children].map((r) => r.loc)).toEqual(['https://a.com/real']);
        expect(result.issues).toEqual([]);
      }
    }
  });

  it('does not let a foreign entry reset or close the surrounding real entry', () => {
    for (const [root, entry] of [['urlset', 'url'], ['sitemapindex', 'sitemap']]) {
      const xml = `<${root} ${NS} xmlns:bad="urn:other"><${entry}><loc>https://a.com/real</loc>`
        + `<bad:${entry}><bad:loc>https://a.com/foreign</bad:loc></bad:${entry}><lastmod>2026-01-01</lastmod>`
        + `</${entry}></${root}>`;
      for (const chunk of [1, 7, xml.length]) {
        const { result, records } = parse(xml, 2000, chunk);
        expect([...records, ...result.children].map((r) => [r.loc, r.lastmod])).toEqual([['https://a.com/real', '2026-01-01']]);
        expect(result.issues).toEqual([]);
      }
    }
  });

  it('reports a declared encoding other than UTF-8, in any case', () => {
    const issue = (decl: string) => parse(`${decl}<urlset ${NS}><url><loc>https://a.com/</loc></url></urlset>`).result.issues;
    expect(issue('<?xml version="1.0" encoding="ISO-8859-1"?>')).toEqual([{
      code: 'encoding-not-utf8', detail: 'encoding-not-utf8', line: 1, params: { encoding: 'ISO-8859-1' }, message: 'Sitemap declares ISO-8859-1 encoding; sitemaps must be UTF-8',
    }]);
    expect(issue("<?xml version='1.0' encoding='utf-16'?>")).toEqual([{
      code: 'encoding-not-utf8', detail: 'encoding-not-utf8', line: 1, params: { encoding: 'utf-16' }, message: 'Sitemap declares utf-16 encoding; sitemaps must be UTF-8',
    }]);
    for (const ok of ['<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="utf-8"?>', '<?xml version="1.0"?>', '']) expect(issue(ok), ok).toEqual([]);
  });

  it('takes only the IANA names utf-8 and us-ascii as UTF-8 compatible', () => {
    const issue = (decl: string) => parse(`${decl}<urlset ${NS}><url><loc>https://a.com/</loc></url></urlset>`).result.issues;
    expect(issue('<?xml version="1.0" encoding="utf8"?>')).toEqual([{
      code: 'encoding-not-utf8', detail: 'encoding-not-utf8', line: 1, params: { encoding: 'utf8' }, message: 'Sitemap declares utf8 encoding; sitemaps must be UTF-8',
    }]);
    for (const ok of ['<?xml version="1.0" encoding="us-ascii"?>', '<?xml version="1.0" encoding="US-ASCII"?>', '<?xml version="1.0" encoding=""?>']) expect(issue(ok), ok).toEqual([]);
  });

  it('reports a bare ampersand in an attribute and a raw "<" in one', () => {
    const { result } = parse(`<urlset ${NS} ${XH}><url><loc>https://a.com/</loc><xhtml:link rel="alternate" hreflang="de" href="https://a.com/?a=1&b=2"/><xhtml:link rel="alternate" hreflang="fr" href="https://a.com/?a<b"/></url></urlset>`);
    expect(result.bareAmpersands).toBe(1);
    expect(result.issues.map((i) => [i.code, i.detail])).toEqual([['xml-error', 'malformed-tag']]);
  });
});

describe('SitemapParser hashed accumulators', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"';
  it('counts repeated urls as duplicates and distinct hreflang sets as clusters', () => {
    const alts = (n: string) => `<xhtml:link rel="alternate" hreflang="en" href="https://a.com/en/${n}"/><xhtml:link rel="alternate" hreflang="de" href="https://a.com/de/${n}"/>`;
    const urls = ['1', '1', '2', '2', '2', '3'].map((n) => `<url><loc>https://a.com/en/${n}</loc>${alts(n)}</url>`).join('');
    const { result } = parse(`<urlset ${NS}>${urls}</urlset>`);
    expect(result.stats).toMatchObject({ urlCount: 6, duplicateCount: 3, clusterCount: 3, languages: ['en', 'de'] });
  });
});

describe('SitemapParser XML-tab rows', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const MAX = MAX_XML_LINE;
  const urlset = (n: number) => `<urlset ${NS}>${Array.from({ length: n }, (_, i) => `<url><loc>https://a.com/page-${i}</loc></url>`).join('')}</urlset>`;

  it('formats a minified one-line sitemap one construct per row, the same at every chunk size', () => {
    const text = urlset(2000);
    expect(text.length).toBeGreaterThan(MAX * 5);
    const whole = parse(text, 2000, text.length).lines;
    expect(whole).toHaveLength(2000 * 3 + 2);
    expect(whole.slice(0, 4)).toEqual([`<urlset ${NS}>`, '  <url>', '    <loc>https://a.com/page-0</loc>', '  </url>']);
    for (const chunk of [5000, 1000, 7]) expect(parse(text, 2000, chunk).lines, `chunk ${chunk}`).toEqual(whole);
  });

  it('cuts a row longer than 8,192 characters into pieces of exactly that many', () => {
    const loc = `https://a.com/${'x'.repeat(20_000)}`;
    const { lines, records } = parse(`<urlset ${NS}><url><loc>${loc}</loc></url></urlset>`, 2000, 999);
    const row = `    <loc>${loc}</loc>`;
    expect(lines.slice(2, -2).map((l) => l.length)).toEqual([MAX, MAX, row.length - 2 * MAX]);
    expect(lines.slice(2, -2).join('')).toBe(row);
    expect(records[0]!.line).toBe(2);
  });

  it('gives a line of exactly 8,192 characters no empty continuation', () => {
    const { lines } = parse('a'.repeat(MAX) + '\n' + 'b'.repeat(MAX + 1) + '\nc');
    expect(lines.map((l) => l.length)).toEqual([MAX, MAX, 1, 1]);
  });

  it('numbers each record by the row of its <url>, past a comment cut into pieces, at every chunk size', () => {
    const header = 'x'.repeat(MAX * 2 - 30);
    const text = `<?xml version="1.0"?>\n<!-- ${header} -->\n${urlset(1500)}\n<!-- end -->\n`;
    for (const chunk of [text.length, 4096, 999, 13]) {
      const { records, lines } = parse(text, 2000, chunk);
      expect(records).toHaveLength(1500);
      expect(lines.slice(1, 3).map((l) => l.length), `chunk ${chunk}`).toEqual([MAX, MAX * 2 - 30 + 9 - MAX]); // the comment's two pieces
      for (const r of records) {
        expect(lines[r.line - 1], `chunk ${chunk}, ${r.loc}`).toBe('  <url>');
        expect(lines[r.line], `chunk ${chunk}, ${r.loc}`).toBe(`    <loc>${r.loc}</loc>`);
      }
    }
  });

  it('keeps the line of a finding past a long line in step with the stored lines', () => {
    const text = `<urlset ${NS}>\n<!-- ${'y'.repeat(MAX * 3)} -->\n<url></url>\n</urlset>`;
    const { result, lines } = parse(text, 2000, 100);
    const issue = result.issues.find((i) => i.code === 'loc-missing')!;
    expect(lines[issue.line! - 1]).toBe('  <url></url>');
  });
});

describe('SitemapParser plain-text sitemaps', () => {
  it('reads one URL per line as a urlset, keeping the raw lines and line numbers', () => {
    const text = '\ufeffhttps://a.com/1\r\n\r\n  https://a.com/2  \nnot a url\nhttps://a.com/1\nhttps://a.com/last';
    for (const chunk of [text.length, 5, 1]) {
      const { result, records, lines } = parse(text, 2000, chunk);
      expect(result.kind).toBe('urlset');
      expect(result.issues).toEqual([]);
      expect(records.map((r) => [r.loc, r.line])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3], ['not a url', 4], ['https://a.com/1', 5], ['https://a.com/last', 6]]);
      expect(Object.keys(records[0]!).sort()).toEqual(['line', 'loc']);
      expect(result.stats).toMatchObject({ urlCount: 5, duplicateCount: 1 });
      expect(lines.join('\n')).toBe(text.replace(/\r\n/g, '\n')); // a line's trailing CR is dropped
    }
  });

  it('applies the usual validations: a non-URL line is an invalid loc, a repeat a duplicate', () => {
    const records: UrlRecord[] = [];
    const v = new ValidationRun({ origin: 'https://a.com', sitemapUrl: 'https://a.com/s.txt', finalUrl: 'https://a.com/s.txt', redirected: false, robots: null, now: 0, contentType: 'text/plain' });
    const p = new SitemapParser({ onRecords: (r, ext) => { v.recordBatch(r, ext); records.push(...r); } });
    p.write('https://a.com/1\nnot a url\nhttps://a.com/1\nhttp://b.com/x\n');
    const f = v.finish(p.finish());
    expect(f.find((x) => x.ruleId === 'invalid-loc')).toEqual({
      ruleId: 'invalid-loc', severity: 'error', message: '<loc> values that are not absolute http(s) URLs', count: 1, examples: [{ value: 'not a url', line: 2 }],
    });
    expect(f.find((x) => x.ruleId === 'duplicate-urls')).toEqual({ ruleId: 'duplicate-urls', severity: 'warning', message: 'Duplicate URLs', count: 1, examples: [{ value: 'https://a.com/1', line: 3 }] });
    expect(f.find((x) => x.ruleId === 'cross-host')).toEqual({
      ruleId: 'cross-host', severity: 'error', message: 'URLs whose scheme, host (www included) or port differs from the sitemap', count: 1, examples: [{ value: 'http://b.com/x', line: 4 }],
    });
    expect(f.find((x) => x.ruleId === 'invalid-root')).toBeUndefined();
  });

  it('keeps reporting XML problems for bodies that do not look like a URL list', () => {
    for (const body of ['just text', 'Not found\nhttps://a.com/1', '{"urls":[]}']) {
      const { result, records } = parse(body);
      expect(result.issues.at(-1), JSON.stringify(body)).toEqual({
        code: 'root-element', detail: 'no-root', line: body.split('\n').length, params: {}, message: 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>',
      });
      expect(records, JSON.stringify(body)).toEqual([]);
    }
    expect(parse('<html></html>').result.issues).toEqual([{
      code: 'root-element', detail: 'wrong-root', line: 1, params: { tag: 'html' }, message: 'root element is <html>, expected <urlset> or <sitemapindex>',
    }]);
  });

  it('settles on the text alone: the same body reads the same whatever the chunk size', () => {
    const rowsOf = (blank: number, chunk: number) => {
      const { result, records, lines } = parse(`${' '.repeat(blank)}https://a.com/1\nhttps://a.com/2`, 2000, chunk);
      return { text: result.text, rows: lines.length, urls: records.length, kind: result.kind };
    };
    for (const blank of [65_536, 65_537]) {
      const want = rowsOf(blank, 131_072);
      expect(want.text, String(blank)).toBe(blank === 65_536);
      expect(rowsOf(blank, 4096)).toEqual(want);
      expect(rowsOf(blank, 1)).toEqual(want);
    }
  });

  it('bounds one huge line and counts the pieces it takes in the stored numbering', () => {
    const text = `https://a.com/${'x'.repeat(20_000)}\nhttps://a.com/2`;
    const { records, lines } = parse(text, 2000, 3000);
    expect(records[0]!.loc).toBe(`https://a.com/${'x'.repeat(20_000)}`.slice(0, 4096));
    expect(records[1]).toEqual({ loc: 'https://a.com/2', line: 4 });
    expect(lines[3]).toBe('https://a.com/2');
    expect(lines.slice(0, 3).map((l) => l.length)).toEqual([MAX_XML_LINE, MAX_XML_LINE, 20_014 - 2 * MAX_XML_LINE]);
  });

  it('keeps a text-sitemap line of 4,096 characters whole and cuts a longer one to 4,096', () => {
    const locOf = (n: number) => parse(`https://${'x'.repeat(n - 8)}\nhttps://a.com/2`, 2000, 3000).records[0]!.loc;
    expect(locOf(4095)).toBe(`https://${'x'.repeat(4087)}`);
    expect(locOf(4096)).toBe(`https://${'x'.repeat(4088)}`);
    expect(locOf(4097)).toBe(`https://${'x'.repeat(4088)}`);
  });
});

describe('SitemapParser index children', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const index = (n: number, loc = (i: number) => `https://a.com/s${i}.xml`) =>
    `<sitemapindex ${NS}>${Array.from({ length: n }, (_, i) => `<sitemap><loc>${loc(i)}</loc></sitemap>`).join('')}</sitemapindex>`;

  it('keeps the first 4,000 children and counts the rest', () => {
    const { result } = parse(index(4_005), 2000, 65_536);
    expect(result.children).toHaveLength(4_000);
    expect(result.children[3_999]!.loc).toBe('https://a.com/s3999.xml');
    expect(result.childOverflow).toBe(5);
    expect(parse(index(10)).result).toMatchObject({ childOverflow: 0 });
  });

  it('cuts a child loc to 2,049 characters, still past the 2,048 limit', () => {
    const long = `https://a.com/${'x'.repeat(5_000)}`;
    const { result } = parse(index(1, () => long), 2000, 65_536);
    expect(result.children[0]!.loc).toBe(long.slice(0, 2_049));
    const exact = `https://a.com/${'y'.repeat(2_034)}`;
    expect(parse(index(1, () => exact)).result.children[0]!.loc).toBe(exact);
  });

  it('still truncates by the total entry count, kept or not', () => {
    const p = new SitemapParser({ onRecords: () => undefined }, 2000, { maxBytes: 1e9, maxUrls: 4_010 });
    p.write(index(4_020));
    expect(p.overLimit).toBe(true);
    expect(p.childOverflow).toBe(20);
  });
});

describe('SitemapParser default limits', () => {
  const MIB = 1024 * 1024;
  const fedUrls = (n: number) => {
    const p = new SitemapParser({ onRecords: () => {} });
    for (let i = 0; i < n; i++) p.write(`https://a.com/${i}\n`);
    return p;
  };
  const fedBytes = (total: number) => {
    const p = new SitemapParser({ onRecords: () => {} });
    const head = 'https://a.com/\n';
    p.write(head);
    for (let left = total - head.length; left > 0; left -= MIB) p.write('x'.repeat(Math.min(left, MIB)));
    return p;
  };

  it('accepts exactly 150,000 urls and stops at the one after', () => {
    const exact = fedUrls(150_000);
    expect(exact.overLimit).toBe(false);
    expect(exact.finish()).toMatchObject({ truncated: false, stats: { urlCount: 150_000 } });
    const over = fedUrls(150_001);
    expect(over.overLimit).toBe(true);
    expect(over.finish()).toMatchObject({ truncated: true, stats: { urlCount: 150_001 } });
  });

  it('accepts exactly 150 MiB and stops at the byte after', () => {
    const exact = fedBytes(150 * MIB);
    expect(exact.overLimit).toBe(false);
    expect(exact.finish()).toMatchObject({ truncated: false, stats: { byteSize: 150 * MIB } });
    const over = fedBytes(150 * MIB + 1);
    expect(over.overLimit).toBe(true);
    expect(over.finish()).toMatchObject({ truncated: true, stats: { byteSize: 150 * MIB + 1 } });
  });

  it('keeps the default of the limit a partial override leaves out', () => {
    const p = new SitemapParser({ onRecords: () => {} }, 2000, { maxUrls: 2 });
    p.write('x'.repeat(MIB));
    expect(p.overLimit).toBe(false);
  });
});

describe('SitemapParser getters and early settling', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

  it('reports the root kind and the rows started so far', () => {
    const p = new SitemapParser({ onRecords: () => {} });
    expect([p.rootKind, p.rowCount]).toEqual(['unknown', 0]);
    p.write(`<sitemapindex ${NS}>\n<sitemap>\n`);
    expect(p.rootKind).toBe('sitemapindex');
    expect(p.rowCount).toBe(2);
    const q = new SitemapParser({ onRecords: () => {} });
    q.write(`<urlset ${NS}>\n<url>\n<loc>https://a.com/</loc>\n`);
    expect(q.rootKind).toBe('urlset');
    expect(q.rowCount).toBe(3);
    const text = new SitemapParser({ onRecords: () => {} });
    text.write('https://a.com/1\nhttps://a.com/2\n');
    expect([text.rootKind, text.rowCount]).toEqual(['urlset', 2]);
  });

  it('settles a short body that starts with < without waiting for more', () => {
    const p = new SitemapParser({ onRecords: () => {} }, 2000, { maxBytes: 2 });
    p.write('<a/>');
    expect(p.overLimit).toBe(true);
  });

  it('settles on a blank run past 65,536 characters even when nothing else has arrived', () => {
    const over = new SitemapParser({ onRecords: () => {} }, 2000, { maxBytes: 100 });
    over.write(' '.repeat(65_537));
    expect(over.overLimit).toBe(true);
    const under = new SitemapParser({ onRecords: () => {} }, 2000, { maxBytes: 100 });
    under.write(' '.repeat(65_536));
    expect(under.overLimit).toBe(false);
  });
});

describe('SitemapParser UTF-8 length', () => {
  const bytesOf = (s: string) => {
    const p = new SitemapParser({ onRecords: () => {} });
    p.write(s);
    return p.finish().stats.byteSize;
  };

  it('counts a lone surrogate as 2 bytes and every other unit as its UTF-8 length', () => {
    const lone = '\udc00';
    const cases: [string, number][] = [
      ['\u007f', 1], ['\u0080', 2], ['߿', 2], ['ࠀ', 3], ['퟿', 3], ['\ud800', 2], ['\udbff', 2], ['\udfff', 2], ['', 3], ['￿', 3],
    ];
    for (const [ch, bytes] of cases) expect(bytesOf(lone + ch), `U+${ch.charCodeAt(0).toString(16)}`).toBe(2 + bytes);
    expect(bytesOf(`${lone}\u{1f600}`)).toBe(2 + 4);
  });

  it('counts well-formed text the way an encoder does', () => {
    for (const ch of ['\u007f', '\u0080', '߿', 'ࠀ', '퟿', '', '￿', '\u{10000}', '\u{10ffff}']) {
      expect(bytesOf(`a${ch}b`), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(Buffer.byteLength(`a${ch}b`));
    }
  });
});

describe('SitemapParser plain-text sitemap edges', () => {
  const rows = (text: string, chunk: number) => parse(text, 2000, chunk).records.map((r) => [r.loc, r.line]);

  it('accepts http:// and https:// starts in any case, but not a scheme with something glued before it', () => {
    const http = parse('http://a.com/1\nHTTP://a.com/2\n');
    expect(http.result.text).toBe(true);
    expect(http.records.map((r) => r.loc)).toEqual(['http://a.com/1', 'HTTP://a.com/2']);
    for (const body of ['xhttp://a.com/1\nhttps://a.com/2', 'ftp://a.com/1\nhttps://a.com/2', 'htt://a.com/1\nhttps://a.com/2']) {
      const { result, records } = parse(body);
      expect(result.text, body).toBe(false);
      expect(records, body).toEqual([]);
      expect(result.issues.at(-1)?.detail, body).toBe('no-root');
    }
  });

  it('numbers a url after a blank line by its row, at any chunking', () => {
    const text = 'https://a.com/1\n\nhttps://a.com/2';
    for (const chunk of [text.length, 16, 17, 1]) expect(rows(text, chunk), String(chunk)).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3]]);
  });

  it('numbers urls after leading newlines by their rows', () => {
    const text = '\nhttps://a.com/1\nhttps://a.com/2';
    for (const chunk of [text.length, 5, 1]) expect(rows(text, chunk), String(chunk)).toEqual([['https://a.com/1', 2], ['https://a.com/2', 3]]);
    expect(rows('\n\nhttps://a.com/1', 100)).toEqual([['https://a.com/1', 3]]);
  });

  it('counts a LF that opens a chunk as its own break after a LF, but as part of the break after a CR', () => {
    const feed = (parts: string[]) => {
      const records: UrlRecord[] = [];
      const p = new SitemapParser({ onRecords: (r) => records.push(...r) });
      for (const part of parts) p.write(part);
      p.finish();
      return records.map((r) => [r.loc, r.line]);
    };
    expect(feed(['https://a.com/1\n', '\nhttps://a.com/2'])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3]]);
    expect(feed(['https://a.com/1\r', '\nhttps://a.com/2'])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 2]]);
    expect(feed(['https://a.com/1\r', '\n\nhttps://a.com/2'])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3]]);
    expect(feed(['https://a.com/1\r\n', '\nhttps://a.com/2'])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3]]);
    expect(feed(['https://a.com/1\n\r', '\nhttps://a.com/2'])).toEqual([['https://a.com/1', 1], ['https://a.com/2', 3]]);
  });

  it('scans a chunk for each kind of line break once per break, not once per line', () => {
    const searches = (text: string) => {
      const counts = { lf: 0, cr: 0 };
      const original = String.prototype.indexOf;
      const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, ...args: Parameters<string['indexOf']>) {
        if (this === text) counts[args[0] === '\n' ? 'lf' : 'cr']++;
        return original.apply(this, args);
      });
      try {
        const p = new SitemapParser({ onRecords: () => {} });
        p.write(text);
        p.finish();
      } finally { spy.mockRestore(); }
      return counts;
    };
    const lines = Array.from({ length: 50 }, (_, i) => `https://a.com/${i}`);
    expect(searches(lines.join('\n') + '\n')).toEqual({ lf: 50, cr: 1 });
    expect(searches(lines.join('\r') + '\r')).toEqual({ lf: 1, cr: 50 });
    expect(searches(lines.join('\r\n') + '\r\n')).toEqual({ lf: 50, cr: 50 });
  });
});

describe('SitemapParser structure edge cases', () => {
  const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const XH = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"';
  const issuesOf = (xml: string, code?: string) => parse(xml).result.issues.filter((i) => !code || i.code === code);
  const urlOf = (loc: string) => `<url><loc>${loc}</loc></url>`;

  it('accepts only utf-8 and us-ascii as encoding names, matched whole', () => {
    const encodings = (name: string) => issuesOf(`<?xml version="1.0" encoding="${name}"?><urlset ${NS}></urlset>`, 'encoding-not-utf8').map((i) => i.params);
    for (const ok of ['utf-8', 'UTF-8', 'us-ascii', 'US-ASCII']) expect(encodings(ok), ok).toEqual([]);
    for (const bad of ['xutf-8', 'utf-8x', 'xus-ascii', 'us-asciix', 'ascii', 'utf8']) expect(encodings(bad), bad).toEqual([{ encoding: bad }]);
  });

  it('cuts a declared encoding name to 64 characters', () => {
    const encodingOf = (n: number) => issuesOf(`<?xml version="1.0" encoding="${'e'.repeat(n)}"?><urlset ${NS}></urlset>`, 'encoding-not-utf8')[0]!.params['encoding'];
    expect(encodingOf(63)).toBe('e'.repeat(63));
    expect(encodingOf(64)).toBe('e'.repeat(64));
    expect(encodingOf(65)).toBe('e'.repeat(64));
  });

  it('reports a closing tag after the root as unexpected, each one, but not after other content', () => {
    const { result, lines } = parse(`<urlset ${NS}>${urlOf('https://a.com/')}</urlset>\n</a></b>`);
    expect(result.issues).toEqual([
      { code: 'xml-error', detail: 'unexpected-close', line: lines.length - 1, params: { tag: 'a' }, message: 'unexpected closing tag </a>' },
      { code: 'xml-error', detail: 'unexpected-close', line: lines.length, params: { tag: 'b' }, message: 'unexpected closing tag </b>' },
    ]);
    const after = parse(`<urlset ${NS}></urlset>x</a><b/></c>`).result.issues;
    expect(after.map((i) => [i.detail, i.params])).toEqual([['content-after-root', {}]]);
  });

  it('describes unclosed elements in the singular and the plural', () => {
    const message = (n: number) => issuesOf(`<urlset ${NS}>${'<g>'.repeat(n)}`, 'xml-error')[0]!.message;
    expect(message(0)).toBe('1 element left unclosed at end of document, innermost <urlset> (truncated file?)');
    expect(message(1)).toBe('2 elements left unclosed at end of document, innermost <g> (truncated file?)');
    expect(message(1500)).toBe('1,501 elements left unclosed at end of document, innermost <g> (truncated file?)');
  });

  it('keeps 64 open elements on the stack and only counts the ones past that', () => {
    const unclosed = (n: number) => issuesOf(`<urlset ${NS}>${Array.from({ length: n }, (_, i) => `<e${i + 1}>`).join('')}`, 'xml-error')[0]!.params;
    expect(unclosed(62)).toEqual({ count: 63, tag: 'e62' });
    expect(unclosed(63)).toEqual({ count: 64, tag: 'e63' });
    expect(unclosed(64)).toEqual({ count: 65, tag: 'e63' });
    expect(unclosed(65)).toEqual({ count: 66, tag: 'e63' });
  });

  it('gives an empty document a finding without a line, and no lastmod share', () => {
    const { result } = parse('');
    expect(result.issues).toStrictEqual([{ code: 'root-element', detail: 'no-root', params: {}, message: 'no root element found: the document is empty or not XML, expected <urlset> or <sitemapindex>' }]);
    expect(result.stats.topLastmodShare).toBe(0);
    expect(parse(`<urlset ${NS}>${urlOf('https://a.com/')}</urlset>`).result.stats.topLastmodShare).toBe(0);
  });

  it('treats unprefixed children of a prefixed root as sitemap elements', () => {
    const { records, result } = parse(`<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">${urlOf('https://a.com/1')}<s:url><s:loc>https://a.com/2</s:loc></s:url></s:urlset>`);
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/1', 'https://a.com/2']);
    expect(result.issues).toEqual([]);
  });

  it('trims the text of a <loc>', () => {
    const { records } = parse(`<urlset ${NS}><url><loc>\n  https://a.com/1 \t</loc></url></urlset>`);
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/1']);
  });

  it('names the innermost wrapper of a misplaced entry, with the full issue', () => {
    const { result, lines } = parse(`<urlset ${NS}><a><b>${urlOf('https://a.com/1')}</b></a></urlset>`);
    expect(result.issues).toEqual([{
      code: 'misplaced-element', detail: 'misplaced-element', line: lineOf(lines, '<url>'), params: { parent: 'b' },
      message: 'unexpected entry or text inside <b>; entries belong directly under the root element',
    }]);
    const index = parse(`<sitemapindex ${NS}><a><b><sitemap><loc>https://a.com/s.xml</loc></sitemap></b></a></sitemapindex>`).result;
    expect(index.issues.map((i) => [i.detail, i.params])).toEqual([['misplaced-element', { parent: 'b' }]]);
    expect(index.children.map((c) => c.loc)).toEqual(['https://a.com/s.xml']);
  });

  it('does not call other elements misplaced', () => {
    for (const xml of [
      `<urlset ${NS}><a><b><c><d/></c></b></a>${urlOf('https://a.com/1')}</urlset>`,
      `<sitemapindex ${NS}><a><b><c><d/></c></b></a><sitemap><loc>https://a.com/s.xml</loc></sitemap></sitemapindex>`,
      `<urlset ${NS}><a><b><x:url/></b></a></urlset>`,
    ]) expect(issuesOf(xml), xml).toEqual([]);
  });

  it('reports text directly under the root with the full issue, and not whitespace', () => {
    const { result } = parse(`<urlset ${NS}>\n\u00a0 stray\n${urlOf('https://a.com/1')}</urlset>`);
    expect(result.issues).toEqual([{
      code: 'misplaced-element', detail: 'misplaced-element', line: 1, params: { parent: 'urlset' },
      message: 'unexpected entry or text inside <urlset>; entries belong directly under the root element',
    }]);
    expect(issuesOf(`<urlset ${NS}>\n\u00a0\t\u2003\n${urlOf('https://a.com/1')}\n</urlset>`)).toEqual([]);
  });

  it('forgets a missing close once its entry is closed or cut off, and reports misplaced entries again', () => {
    const misplaced = (xml: string) => issuesOf(xml, 'misplaced-element').map((i) => i.params['parent']);
    const open = '<url><loc>https://a.com/1</loc>';
    expect(misplaced(`<urlset ${NS}>${open}${urlOf('https://a.com/2')}${urlOf('https://a.com/3')}</url></urlset>`)).toEqual([]);
    expect(misplaced(`<urlset ${NS}>${open}${urlOf('https://a.com/2')}</url><a><b>${urlOf('https://a.com/3')}</b></a></urlset>`)).toEqual(['b']);
    expect(misplaced(`<urlset ${NS}><wrap>${open}${urlOf('https://a.com/2')}</wrap></url><a><b>${urlOf('https://a.com/3')}</b></a></urlset>`)).toEqual(['wrap', 'b']);
  });

  it('reports every entry of a wrapper that follows a closed entry', () => {
    const entries = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'].map(urlOf);
    const { result, records } = parse(`<urlset ${NS}>${entries[0]}<wrap>${entries[1]}${entries[2]}</wrap></urlset>`);
    expect(records.map((r) => r.loc)).toEqual(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    expect(result.issues.map((i) => [i.detail, i.params])).toEqual([['misplaced-element', { parent: 'wrap' }], ['misplaced-element', { parent: 'wrap' }]]);
  });

  it('keeps tracking a missing close below the depth cap without blaming later entries', () => {
    const deep = '<g>'.repeat(70);
    const closes = '</g>'.repeat(70);
    const { result } = parse(`<urlset ${NS}>${deep}<url><loc>https://a.com/1</loc><url><loc>https://a.com/2</loc></url>${closes}<a><b>${urlOf('https://a.com/3')}</b></a></urlset>`);
    expect(result.issues.map((i) => i.detail)).toEqual(['url-not-closed', 'misplaced-element', 'close-mismatch']);
    expect(result.issues[1]!.params).toEqual({ parent: 'b' });
  });

  it('does not read entries of a document whose root is not a sitemap', () => {
    const html = parse(`<html><url><loc>https://a.com/1</loc></url><sitemap><loc>https://a.com/s.xml</loc></sitemap></html>`);
    expect(html.records).toEqual([]);
    expect(html.result.children).toEqual([]);
    expect(html.result.issues.map((i) => i.detail)).toEqual(['wrong-root']);
  });

  it('keeps no record for a <url> that never closed and had no <loc>', () => {
    const { records, result } = parse(`<urlset ${NS}><url><lastmod>2026-01-01</lastmod><url><loc>https://a.com/2</loc></url></urlset>`);
    expect(records).toEqual([{ loc: 'https://a.com/2', line: 4 }]);
    expect(result.stats.urlCount).toBe(1);
  });

  it('describes a <url> opened before the previous one closed', () => {
    const { result } = parse(`<urlset ${NS}>\n<url><loc>https://a.com/1</loc>\n<url><loc>https://a.com/2</loc></url></urlset>`);
    expect(result.issues[0]).toEqual({
      code: 'xml-error', detail: 'url-not-closed', line: 4, params: { line: '4', openLine: '2' },
      message: '<url> opened at line 4 before the <url> from line 2 was closed',
    });
  });

  it('ignores text after a self-closed <loc/> that a stray close tag would otherwise adopt', () => {
    const { records, result } = parse(`<urlset ${NS}><url><loc/>https://a.com/x</loc></url></urlset>`);
    expect(records).toEqual([]);
    expect(result.issues.map((i) => [i.detail, i.params])).toEqual([['close-mismatch', { tag: 'loc', open: 'url' }], ['url-without-loc', {}]]);
  });

  it('reads only xhtml links with rel="alternate" as alternates, inside a <url>', () => {
    const xml = `<urlset ${NS} ${XH}><xhtml:link rel="alternate" hreflang="zz" href="https://a.com/outside"/><url><loc>https://a.com/</loc>`
      + '<xhtml:link rel="nofollow" hreflang="de" href="https://a.com/de"/><xhtml:a rel="alternate" hreflang="fr" href="https://a.com/fr"/>'
      + '<xhtml:link rel="alternate" href="https://a.com/none"/><xhtml:link rel="alternate" hreflang="it" href="https://a.com/it"/></url><xhtml:link rel="alternate" hreflang="zz" href="https://a.com/after"/></urlset>';
    const { records, result } = parse(xml);
    expect(records[0]!.alternates).toEqual([{ hreflang: '', href: 'https://a.com/none' }, { hreflang: 'it', href: 'https://a.com/it' }]);
    expect(result.issues).toEqual([]);
  });

  it('names a non-xhtml alternate link by its first 100 characters, with the full issue', () => {
    const tag = `${'p'.repeat(150)}:link`;
    const { result } = parse(`<urlset ${NS}><url><loc>https://a.com/</loc><${tag} rel="alternate" hreflang="de" href="https://a.com/de"/></url></urlset>`);
    const shown = tag.slice(0, 100);
    expect(result.issues).toEqual([{
      code: 'alternate-wrong-namespace', detail: 'alternate-wrong-namespace', line: 4, params: { name: shown },
      message: `<${shown} rel="alternate"> is not in the xhtml namespace (http://www.w3.org/1999/xhtml), so it is not read as an hreflang alternate`,
    }]);
  });

  it('cuts a field to 8,192 characters, whichever field it is', () => {
    const fieldOf = (field: string, n: number) => (parse(`<urlset ${NS}><url><loc>https://a.com/</loc><${field}>${'1'.repeat(n)}</${field}></url></urlset>`).records[0] as unknown as Record<string, string>)[field];
    for (const field of ['lastmod', 'changefreq', 'priority']) {
      expect(fieldOf(field, 8191), field).toBe('1'.repeat(8191));
      expect(fieldOf(field, 8192), field).toBe('1'.repeat(8192));
      expect(fieldOf(field, 8193), field).toBe('1'.repeat(8192));
    }
  });

  it('keeps a child and its lastmod when an unrelated element closes inside the <sitemap>', () => {
    const { result } = parse(`<sitemapindex ${NS}><sitemap><loc>https://a.com/s.xml</loc><x><y/></x><lastmod>2026-01-01</lastmod></sitemap></sitemapindex>`);
    expect(result.children).toEqual([{ loc: 'https://a.com/s.xml', lastmod: '2026-01-01', line: 2 }]);
    expect(result.childOverflow).toBe(0);
    const prefixed = parse(`<sitemapindex ${NS}><sitemap><loc>https://a.com/s.xml</loc><z:sitemap/><lastmod>2026-01-01</lastmod></z:sitemap></sitemap></sitemapindex>`).result;
    expect(prefixed.children.map((c) => c.lastmod)).toEqual(['2026-01-01']);
  });

  it('ignores entries of the other kind nested inside an entry, and reports them elsewhere', () => {
    expect(issuesOf(`<urlset ${NS}><url><loc>https://a.com/1</loc><sitemap><x/></sitemap></url></urlset>`)).toEqual([]);
    expect(issuesOf(`<sitemapindex ${NS}><sitemap><loc>https://a.com/s.xml</loc><url><x/></url></sitemap></sitemapindex>`)).toEqual([]);
    expect(issuesOf(`<sitemapindex ${NS}><foo:url/></sitemapindex>`)).toEqual([]);
    const after = issuesOf(`<sitemapindex ${NS}><sitemap><loc>https://a.com/s.xml</loc></sitemap><url><loc>https://a.com/1</loc></url></sitemapindex>`);
    expect(after.map((i) => [i.detail, i.params])).toEqual([['wrong-entry-kind', { found: 'url', root: 'sitemapindex' }]]);
  });

  it('cuts the uri of an unknown extension namespace to 300 characters', () => {
    const uri = `http://www.google.com/schemas/sitemap-image/${'x'.repeat(400)}`;
    const { result } = parse(`<urlset ${NS} xmlns:image="${uri}"></urlset>`);
    expect(result.issues).toEqual([{
      code: 'extension-namespace-unknown', detail: 'extension-namespace-unknown', line: 1, params: { prefix: 'image', uri: uri.slice(0, 300) },
      message: `xmlns:image is bound to "${uri.slice(0, 300)}", which is not the namespace Google documents for it`,
    }]);
  });

  it('groups alternates into a cluster whatever their order, and keeps their hrefs apart', () => {
    const entry = (n: number, hrefs: string[]) => `<url><loc>https://a.com/${n}</loc>${hrefs.map((h) => `<xhtml:link rel="alternate" hreflang="en" href="${h}"/>`).join('')}</url>`;
    const clusters = (...entries: string[]) => parse(`<urlset ${NS} ${XH}>${entries.join('')}</urlset>`).result.stats.clusterCount;
    expect(clusters(entry(1, ['https://a.com/x', 'https://a.com/y']), entry(2, ['https://a.com/y', 'https://a.com/x']))).toBe(1);
    expect(clusters(entry(1, ['a', 'bc']), entry(2, ['ab', 'c']))).toBe(2);
  });

  it('counts the lastmod share over urls with a lastmod only, and ties keep the first instant', () => {
    const lm = (n: number, v?: string) => `<url><loc>https://a.com/${n}</loc>${v ? `<lastmod>${v}</lastmod>` : ''}</url>`;
    const { result } = parse(`<urlset ${NS}>${lm(1)}${lm(2)}${lm(3, '2026-05-01T12:00:00Z')}</urlset>`);
    expect(result.stats.topLastmodShare).toBe(1 / 3);
    const tie = parse(`<urlset ${NS}>${lm(1, '2026-05-01T12:00:00Z')}${lm(2, '2026-05-01T13:00:00+01:00')}</urlset>`).result.stats;
    expect([tie.lastmodMin, tie.lastmodMax]).toEqual(['2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z']);
  });

  it('tracks 1,000 distinct lastmod values and counts only those afterwards', () => {
    const share = (distinct: number) => {
      const urls = Array.from({ length: distinct + 5 }, (_, i) => `<url><loc>https://a.com/${i}</loc><lastmod>${i < distinct ? `v${i}` : 'late'}</lastmod></url>`).join('');
      return parse(`<urlset ${NS}>${urls}</urlset>`, 2000, 65_536).result.stats.topLastmodShare;
    };
    expect(share(998)).toBe(5 / 1003);
    expect(share(999)).toBe(5 / 1004);
    expect(share(1000)).toBe(1 / 1005);
  });

  it('caps stored findings per code, independently of other codes', () => {
    const dup = (n: number) => Array.from({ length: n }, (_, i) => `<url><loc>https://a.com/${i}</loc><loc>https://a.com/x</loc></url>`).join('');
    const count = (n: number, code: string, extra = '') => issuesOf(`<urlset ${NS}>${dup(n)}${extra}</urlset>`, code).length;
    expect(count(19, 'duplicate-field')).toBe(19);
    expect(count(20, 'duplicate-field')).toBe(20);
    expect(count(21, 'duplicate-field')).toBe(20);
    expect(count(30, 'duplicate-field', '</a></b>')).toBe(20);
    expect(count(30, 'xml-error', '</a></b>')).toBe(2);
  });
});
