import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_XML_LINE, XmlPrinter } from './printer.js';
import { XmlTokenizer, decodeEntities, type XmlToken } from './tokenizer.js';

const tokenizer = () => new XmlTokenizer(new XmlPrinter());

// Tokens without their lines: most tests here are about what is read; lines have their own tests, against the printed rows.
const unlined = (tokens: XmlToken[]) => tokens.map((t) => { const { line: _line, ...rest } = t; return rest; });

function all(chunks: string[]) {
  const tk = tokenizer();
  const out = chunks.flatMap((c) => tk.write(c));
  return unlined(out.concat(tk.end()));
}

const lineOf = (rows: string[], needle: string) => rows.findIndex((r) => r.includes(needle)) + 1;

// `str` cut into pieces of `size` characters (UTF-16 code units, so a surrogate pair can be split).
const slices = (str: string, size: number) => Array.from({ length: Math.ceil(str.length / size) }, (_, k) => str.slice(k * size, (k + 1) * size));

// Token builders, without lines.
const open = (name: string, attrs: Record<string, string> = {}, selfClosing = false) => ({ type: 'open', name, attrs, selfClosing });
const close = (name: string) => ({ type: 'close', name });
const text = (value: string) => ({ type: 'text', text: value });
const error = (code: string, message: string, params: Record<string, unknown> = {}) => ({ type: 'error', message, code, params });
const UNTERMINATED_COMMENT = 'comment is unterminated or too long, skipping it';
const UNTERMINATED_DECLARATION = 'declaration is unterminated or too long, skipping it';
const UNTERMINATED_MARKUP = 'unterminated markup';

describe('decodeEntities', () => {
  it('decodes named and numeric entities, leaves unknown intact', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x41; &quot;&apos;')).toBe(`a & b <c> A A "'`);
    expect(decodeEntities('&bogus; &#xZZ;')).toBe('&bogus; &#xZZ;');
  });

  it('never resolves Object.prototype members or malformed numerics', () => {
    expect(decodeEntities('&constructor; &toString; &__proto__; &hasOwnProperty;')).toBe('&constructor; &toString; &__proto__; &hasOwnProperty;');
    expect(decodeEntities('&#abc; &#x110000; &#99999999999;')).toBe('&#abc; &#x110000; &#99999999999;');
  });
});

describe('XmlTokenizer', () => {
  it('tokenizes a simple document, numbering each token by the printed row it starts on', () => {
    const { tokens, rows } = run('<?xml version="1.0"?>\n<urlset xmlns="ns">\n<url><loc>https://a.com/&amp;x</loc></url>\n</urlset>', 1000);
    expect(rows).toEqual(['<?xml version="1.0"?>', '<urlset xmlns="ns">', '  <url>', '    <loc>https://a.com/&amp;x</loc>', '  </url>', '</urlset>']);
    expect(tokens).toEqual([
      { type: 'open', name: 'urlset', attrs: { xmlns: 'ns' }, selfClosing: false, line: 2 },
      { type: 'open', name: 'url', attrs: {}, selfClosing: false, line: 3 },
      { type: 'open', name: 'loc', attrs: {}, selfClosing: false, line: 4 },
      { type: 'text', text: 'https://a.com/&x', line: 4 },
      { type: 'close', name: 'loc', line: 4 },
      { type: 'close', name: 'url', line: 5 },
      { type: 'close', name: 'urlset', line: 6 },
    ]);
  });

  it('keeps attributes in a prototype-free object, so __proto__ and constructor are plain attribute names', () => {
    const [t] = all(['<url __proto__="a" constructor="b" toString="c"/>']);
    expect(t?.type).toBe('open');
    if (t?.type !== 'open') return;
    expect(Object.getPrototypeOf(t.attrs)).toBeNull();
    expect(Object.entries(t.attrs)).toEqual([['__proto__', 'a'], ['constructor', 'b'], ['toString', 'c']]);
    expect('hasOwnProperty' in t.attrs).toBe(false);
  });

  it('handles self-closing tags with attributes (hreflang links)', () => {
    const t = all(['<xhtml:link rel="alternate" hreflang="de" href="https://a.com/de/"/>']);
    expect(t[0]).toEqual({
      type: 'open', name: 'xhtml:link', selfClosing: true,
      attrs: { rel: 'alternate', hreflang: 'de', href: 'https://a.com/de/' },
    });
  });

  it('survives markup split across chunk boundaries', () => {
    const doc = '<url><loc>https://a.com/page</loc></url>';
    for (let cut = 1; cut < doc.length - 1; cut++) {
      expect(all([doc.slice(0, cut), doc.slice(cut)]), `cut ${cut}`).toEqual([open('url'), open('loc'), text('https://a.com/page'), close('loc'), close('url')]);
    }
  });

  it('buffers a partial entity at a chunk end', () => {
    expect(all(['<loc>https://a.com/?a=1&am', 'p;b=2</loc>'])).toEqual([open('loc'), text('https://a.com/?a=1&b=2'), close('loc')]);
  });

  it('skips comments and CDATA becomes text', () => {
    const { tokens, rows } = run('<a><!-- hi\nthere --><![CDATA[x<y]]></a>', 1000);
    expect(rows).toEqual(['<a>', '  <!-- hi', 'there -->', '  <![CDATA[x<y]]>', '</a>']);
    expect(tokens).toEqual([
      { type: 'open', name: 'a', attrs: {}, selfClosing: false, line: 1 },
      { type: 'text', text: 'x<y', line: 4 }, // the CDATA section after the comment gets its own row
      { type: 'close', name: 'a', line: 5 },
    ]);
  });

  it('emits error tokens for malformed markup and recovers at the next tag', () => {
    expect(all(['<a><<oops</a bad><b>ok</b>'])).toEqual([
      open('a'),
      error('unterminated-markup', UNTERMINATED_MARKUP), // "<<": the first "<" has no ">" before the next "<"
      error('unterminated-markup', UNTERMINATED_MARKUP), // "<oops" runs into "</a bad>"
      error('malformed-close-tag', 'malformed closing tag </a bad>', { tag: 'a bad' }),
      open('b'), text('ok'), close('b'),
    ]);
  });

  it('reports unterminated content at end() and drops the text it never closed', () => {
    expect(all(['<url><loc>https://a.com'])).toEqual([
      open('url'), open('loc'), error('unterminated-content', 'unterminated content at end of document'),
    ]);
  });

  it('counts bare ampersands in text', () => {
    const tk = tokenizer();
    expect(unlined(tk.write('<loc>https://a.com/?a=1&b=2&amp;c=3</loc>'))).toEqual([open('loc'), text('https://a.com/?a=1&b=2&c=3'), close('loc')]);
    tk.end();
    expect(tk.bareAmpersands).toBe(1);
  });

  it('counts entities the decoder would reject as bare ampersands', () => {
    const tk = tokenizer();
    expect(unlined(tk.write('<loc>&#abc; &constructor; &#65; &amp; &#x110000;</loc>'))).toEqual([open('loc'), text('&#abc; &constructor; A & &#x110000;'), close('loc')]);
    tk.end();
    expect(tk.bareAmpersands).toBe(3);
  });

  it('keeps a ">" inside a quoted attribute value, whole or split across chunks', () => {
    const doc = '<xhtml:link rel="alternate" href="https://a.com/?a>b" hreflang=\'de\'/>';
    const want = { type: 'open', name: 'xhtml:link', selfClosing: true, attrs: { rel: 'alternate', href: 'https://a.com/?a>b', hreflang: 'de' } };
    expect(all([doc])).toEqual([want]);
    for (let cut = 1; cut < doc.length; cut++) expect(all([doc.slice(0, cut), doc.slice(cut)])).toEqual([want]);
  });

  it('is not thrown off by a stray quote outside an attribute value', () => {
    expect(all([`<a it's>x</a>`])).toEqual([open('a'), text('x'), close('a')]);
  });

  it('parses a pathological attribute name in linear time', () => {
    const t0 = performance.now();
    const t = all([`<x ${'a'.repeat(60000)}>`]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(t).toEqual([open('x')]);
  });

  describe('markup cap', () => {
    // '<a' + spaces + '>': the closing ">" sits `offset` characters after the "<"
    const tagWithCloserAt = (offset: number) => `<a${' '.repeat(offset - 2)}>`;

    it('reads a tag whose ">" is 65,536 characters after its "<" and rejects one that is a character further, at any chunk size', () => {
      for (const size of [100_000, 65_536, 1000, 7]) {
        expect(unlined(run(`${tagWithCloserAt(65_536)}<b/>`, size).tokens), `kept, size ${size}`).toEqual([open('a'), open('b', {}, true)]);
        expect(unlined(run(`${tagWithCloserAt(65_537)}<b/>`, size).tokens), `cut, size ${size}`).toEqual([
          error('markup-too-long', 'markup longer than 65,536 characters', { max: 65_536 }),
          open('b', {}, true),
        ]);
      }
    });

    it('rejects a complete tag far past the cap and keeps the markup after it, at any chunk size', () => {
      const doc = `<a href="${'x'.repeat(70000)}">o&k</a><b/>`;
      const whole = run(doc, doc.length);
      expect(unlined(whole.tokens)).toEqual([
        error('markup-too-long', 'markup longer than 65,536 characters', { max: 65_536 }),
        close('a'), open('b', {}, true),
      ]);
      // what follows the cut, up to the next "<", belongs to the rejected markup even when it arrives in a later chunk
      for (const size of [1000, 7]) expect(run(doc, size), `size ${size}`).toEqual(whole);
      expect(whole.bare).toBe(0);
      expect(whole.rows.join('')).toBe(doc);
    });

    it('reads a comment up to 65,536 characters before its "-->" and discards one that is a character longer', () => {
      for (const size of [100_000, 1000, 7]) {
        expect(unlined(run(`<!--${'x'.repeat(65_532)}--><b/>`, size).tokens), `kept, size ${size}`).toEqual([open('b', {}, true)]);
        expect(unlined(run(`<!--${'x'.repeat(65_533)}--><b/>`, size).tokens), `cut, size ${size}`).toEqual([
          error('unterminated-comment', UNTERMINATED_COMMENT), open('b', {}, true),
        ]);
      }
    });

    it('prints a discarded comment, CDATA section, PI and declaration verbatim and numbers what follows by its own row', () => {
      for (const [opener, closer, errorCode, size] of [
        ['<!--', '-->', 'unterminated-comment', 73_722],
        ['<![CDATA[', ']]>', 'unterminated-cdata', 1_048_568],
        ['<?pi ', '>', 'unterminated-pi', 73_723],
        ['<!X ', '>', 'unterminated-declaration', 73_724],
      ] as const) {
        const doc = `${opener}${'x'.repeat(size)}${closer}<b/>`;
        for (const chunk of [doc.length, 10_000]) {
          const { tokens: t, rows } = run(doc, chunk);
          expect(t.map((x) => x.type), `${opener} ${chunk}`).toEqual(['error', 'open']);
          expect(t[0], `${opener} ${chunk}`).toMatchObject({ code: errorCode, line: 1 });
          expect(rows.join(''), `${opener} ${chunk}`).toBe(doc);
          expect(rows.at(-1), `${opener} ${chunk}`).toBe('<b/>');
          expect(t[1], `${opener} ${chunk}`).toMatchObject({ name: 'b', line: rows.length });
        }
      }
    });

    it('applies the same cap to a processing instruction and a DOCTYPE', () => {
      for (const [opener, code, message] of [
        ['<?pi ', 'unterminated-pi', 'processing instruction is unterminated or too long, skipping it'],
        ['<!DOCTYPE x ', 'unterminated-declaration', UNTERMINATED_DECLARATION], // a '[' would open a subset that the '>' does not end
      ] as const) {
        expect(all([opener, 'y'.repeat(70000), '><c/>']), opener).toEqual([error(code, message), open('c', {}, true)]);
      }
    });

    it('resyncs at a stray "<" instead of rescanning for a closing ">", reporting each one', () => {
      const t0 = performance.now();
      const t = all(['<'.repeat(200000), '<b/>']);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(t).toHaveLength(200_001);
      expect(t.slice(0, 200_000).every((x) => x.type === 'error' && x.code === 'unterminated-markup')).toBe(true);
      expect(t.at(-1)).toEqual(open('b', {}, true));
    });

    it('feeds an oversized unterminated comment in small chunks in linear time, then resumes after it', () => {
      const doc = `<a><!--${'x'.repeat(300_000)}\n--><b/></a>`;
      const t0 = performance.now();
      const { tokens, rows } = run(doc, 100);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(unlined(tokens)).toEqual([open('a'), error('unterminated-comment', UNTERMINATED_COMMENT), open('b', {}, true), close('a')]);
      // "  <!--" and 300,000 characters fill 36 full rows and part of a 37th; the newline starts row 39 ("-->"), <b/> is on 40
      expect(rows.length).toBe(41);
      expect(tokens.map((t) => t.line)).toEqual([1, 2, 40, 41]);
      expect(rows[39]).toBe('  <b/>');
    });
  });

  describe('CDATA and text caps', () => {
    it('keeps a CDATA section whose "<![CDATA[" plus content is 1,048,576 characters and discards one that is a character longer', () => {
      const cdata = (n: number) => `<![CDATA[${'x'.repeat(n)}]]><b/>`;
      for (const size of [2_000_000, 10_000]) {
        expect(unlined(run(cdata(1_048_567), size).tokens), `kept, size ${size}`).toEqual([text('x'.repeat(1_048_567)), open('b', {}, true)]);
        const cut = unlined(run(cdata(1_048_568), size).tokens);
        expect(cut, `cut, size ${size}`).toHaveLength(2);
        expect(cut[0], `cut, size ${size}`).toEqual(error('unterminated-cdata', 'CDATA section is unterminated or too long, skipping it'));
        expect(cut[1], `cut, size ${size}`).toEqual(open('b', {}, true)); // starts at index 1,048,580 = 128 * 8,192 + 4
      }
    });

    it('discards a CDATA section far past the cap without buffering it, and resumes after it', () => {
      const t0 = performance.now();
      const t = all(['<a><![CDATA[', ...Array.from({ length: 150 }, () => 'z'.repeat(10000)), ']]><b/></a>']);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(t).toEqual([open('a'), error('unterminated-cdata', 'CDATA section is unterminated or too long, skipping it'), open('b', {}, true), close('a')]);
    });

    it('reads unterminated CDATA fed in tiny chunks in time proportional to its size, not quadratic in the buffer', () => {
      const t0 = performance.now();
      const t = all(['<a>', ...slices('<![CDATA[' + 'x'.repeat(1 << 20), 64), '<b/></a>']);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(t.slice(0, 2)).toEqual([open('a'), error('unterminated-cdata', 'CDATA section is unterminated or too long, skipping it')]);
    });

    it('finds a terminator, a comment end and a PI end split across tiny chunks', () => {
      const doc = `<a><![CDATA[${'q'.repeat(300)}]]><!-- ${'c'.repeat(300)} --><?pi ${'p'.repeat(300)}?><b/></a>`;
      for (const size of [1, 2, 3, 7]) expect(all(slices(doc, size)), `size ${size}`).toEqual([open('a'), text('q'.repeat(300)), open('b', {}, true), close('a')]);
    });

    // The caps below are MAX_CDATA (1,048,576, '<![CDATA[' included) and MAX_TAG (65,536, '<!--' included) in tokenizer.ts; neither is exported.
    it('reads unterminated CDATA at the 1,048,576 cap and one past it the same in 7-character chunks as in one', () => {
      for (const length of [1_048_576, 1_048_577]) {
        const doc = `<a><![CDATA[${'x'.repeat(length - 9)}`;
        const whole = unlined(run(doc, doc.length).tokens);
        expect(unlined(run(doc, 7).tokens), `length ${length}`).toEqual(whole);
        expect(whole[0], `length ${length}`).toEqual(open('a'));
        expect(whole.some((t) => t.type === 'error'), `length ${length}`).toBe(true);
      }
    });

    it('reads unterminated comments at the 65,536 cap and one past it the same in 7-character chunks as in one', () => {
      for (const length of [65_536, 65_537]) {
        const doc = `<a><!--${'c'.repeat(length - 4)}`;
        const whole = unlined(run(doc, doc.length).tokens);
        expect(unlined(run(doc, 7).tokens), `length ${length}`).toEqual(whole);
        expect(whole[0], `length ${length}`).toEqual(open('a'));
        expect(whole.some((t) => t.type === 'error'), `length ${length}`).toBe(true);
      }
    });

    it('ends a document with a CDATA, comment or PI still held after tiny chunks the same as in one chunk', () => {
      for (const construct of ['<![CDATA[' + 'q'.repeat(50), '<!--' + 'c'.repeat(50), '<?pi ' + 'p'.repeat(50)]) {
        const doc = `<a>${construct}`;
        const whole = unlined(run(doc, doc.length).tokens);
        for (const size of [1, 2, 3, 7]) expect(unlined(run(doc, size).tokens), `${construct.slice(0, 4)} at ${size}`).toEqual(whole);
      }
    });

    it('keeps a surrogate pair split across chunks whole inside CDATA and inside a comment', () => {
      const cdata = '<a><![CDATA[x😀y]]></a>';
      const comment = '<a><!--x😀y--><b/></a>';
      for (const size of [1, 2, 3]) {
        expect(unlined(run(cdata, size).tokens), `cdata at ${size}`).toEqual([open('a'), text('x😀y'), close('a')]);
        expect(unlined(run(comment, size).tokens), `comment at ${size}`).toEqual([open('a'), open('b', {}, true), close('a')]);
      }
    });

    it('ignores 10,000 empty writes while a comment is held, and the terminator still closes it', () => {
      const tk = tokenizer();
      const out = tk.write('<a><!--x');
      for (let k = 0; k < 10_000; k++) out.push(...tk.write(''));
      out.push(...tk.write('--><b/></a>'), ...tk.end());
      expect(unlined(out)).toEqual([open('a'), open('b', {}, true), close('a')]);
    });

    it('keeps a terminated CDATA well under the cap intact', () => {
      expect(all(['<a><![CDATA[', 'q'.repeat(200000), ']]></a>'])).toEqual([open('a'), text('q'.repeat(200000)), close('a')]);
    });

    it('keeps an accumulated text run of 65,536 characters whole and cuts a longer one, keeping the first characters', () => {
      const run65536 = all(['<a>', ...Array.from({ length: 6 }, () => 'w'.repeat(10000)), 'w'.repeat(5536), '</a>']);
      expect(run65536.find((x) => x.type === 'text')).toEqual(text('w'.repeat(65_536)));
      const longer = all(['<a>', ...Array.from({ length: 6 }, () => 'a'.repeat(10000)), 'a'.repeat(5536), 'b'.repeat(10), '</a>']);
      expect(longer.find((x) => x.type === 'text')).toEqual(text('a'.repeat(65_536)));
      expect(all(['<a>', 'w'.repeat(65_537), '</a>']).find((x) => x.type === 'text')).toEqual(text('w'.repeat(65_536)));
    });
  });

  it('gives error tokens a code and params the UI can translate', () => {
    expect(all(['<url><loc>https://a.com']).at(-1)).toEqual(error('unterminated-content', 'unterminated content at end of document'));
    expect(all(['<a>x</a bad>']).find((x) => x.type === 'error')).toEqual(error('malformed-close-tag', 'malformed closing tag </a bad>', { tag: 'a bad' }));
    expect(all([`<!--${'x'.repeat(70_000)}-->`]).find((x) => x.type === 'error')).toEqual(error('unterminated-comment', UNTERMINATED_COMMENT));
  });
});

// Everything the tokenizer reports for one document fed in pieces of `size` characters.
// `rows` are the XML-tab rows the printer made of it.
function run(doc: string, size: number) {
  const rows: string[] = [];
  const printer = new XmlPrinter((r) => rows.push(...r));
  const tk = new XmlTokenizer(printer);
  const tokens = [];
  for (let i = 0; i < doc.length; i += size) tokens.push(...tk.write(doc.slice(i, i + size)));
  tokens.push(...tk.end());
  printer.finish();
  return { tokens, bare: tk.bareAmpersands, rows };
}

describe('attributes', () => {
  it('counts a bare ampersand in an attribute value like one in text', () => {
    const tk = tokenizer();
    const t = tk.write('<xhtml:link rel="alternate" href="https://a.com/?a=1&b=2&amp;c=3" hreflang=\'de\'/>');
    expect(tk.bareAmpersands).toBe(1);
    expect(unlined(t)).toEqual([open('xhtml:link', { rel: 'alternate', href: 'https://a.com/?a=1&b=2&c=3', hreflang: 'de' }, true)]);
  });

  it('reports a raw "<" inside an attribute value as malformed markup and still delivers the tag', () => {
    const t = all(['<xhtml:link rel="alternate" href="https://a.com/?a<b"/>']);
    expect(t).toEqual([
      error('malformed-tag', 'malformed tag <xhtml:link rel="alternate" href="https://a.com/?a<b"/>', { tag: 'xhtml:link rel="alternate" href="https://a.com/?a<b"/' }),
      open('xhtml:link', { rel: 'alternate', href: 'https://a.com/?a<b' }, true),
    ]);
  });

  it('leaves a clean attribute value alone', () => {
    const tk = tokenizer();
    expect(unlined(tk.write('<a href="x&amp;y&#38;z&lt;"/>'))).toEqual([open('a', { href: 'x&y&z<' }, true)]);
    expect(tk.bareAmpersands).toBe(0);
  });
});

describe('DOCTYPE', () => {
  const evil = '<!DOCTYPE urlset [<!ENTITY e "x><url><loc>https://evil.example/</loc></url>">]>';

  it('skips an internal subset as a whole, so markup inside an entity value is never parsed', () => {
    const doc = `<?xml version="1.0"?>${evil}<urlset><url><loc>https://a.com/1</loc></url></urlset>`;
    for (const size of [doc.length, 1, 3, 7, 40]) {
      expect(unlined(run(doc, size).tokens), `size ${size}`).toEqual([
        open('urlset'), open('url'), open('loc'), text('https://a.com/1'), close('loc'), close('url'), close('urlset'),
      ]);
    }
  });

  it('never expands an entity declared in the DOCTYPE: the reference stays literal text and counts as a bare ampersand', () => {
    const doc = '<!DOCTYPE a [<!ENTITY e "https://evil.example/">]><a>&e;</a>';
    for (const size of [doc.length, 1, 5]) {
      const r = run(doc, size);
      expect(unlined(r.tokens), `size ${size}`).toEqual([open('a'), text('&e;'), close('a')]);
      expect(r.bare, `size ${size}`).toBe(1);
    }
  });

  it('is not fooled by quotes, comments and processing instructions inside the subset', () => {
    const doc = `<!DOCTYPE a [ <!-- it's > ] --> <?pi " > ?> <!ENTITY b 'q">' > <!ENTITY c "d'>"> ]><a/>`;
    for (const size of [doc.length, 1, 2, 5]) {
      expect(unlined(run(doc, size).tokens), `size ${size}`).toEqual([open('a', {}, true)]);
    }
  });

  it('prints the lines it skips verbatim and numbers what follows after them', () => {
    const { tokens, rows } = run(`<!DOCTYPE a [\n<!ENTITY x "1">\n]>\n<a/>`, 1000);
    expect(rows).toEqual(['<!DOCTYPE a [', '<!ENTITY x "1">', ']>', '<a/>']);
    expect(tokens).toEqual([{ type: 'open', name: 'a', attrs: {}, selfClosing: true, line: 4 }]);
  });

  it('reports an unterminated DOCTYPE at the end of the document', () => {
    expect(all(['<!DOCTYPE a [ <!ENTITY x "1">'])).toEqual([error('unterminated-declaration', UNTERMINATED_DECLARATION)]);
  });

  it('applies the markup cap to the whole DOCTYPE at any chunk size', () => {
    const doc = `<!DOCTYPE x [${'y'.repeat(70000)}]><c/>`;
    for (const size of [doc.length, 1000, 65536]) {
      expect(unlined(run(doc, size).tokens), `size ${size}`).toEqual([error('unterminated-declaration', UNTERMINATED_DECLARATION), open('c', {}, true)]);
    }
  });
});

describe('DOCTYPE past the markup cap', () => {
  // '>' of the <!ELEMENT> declarations sit inside the subset, so only the "]>" ends the DOCTYPE
  const subset = '<!ELEMENT e (#PCDATA)>\n<!-- <url><loc>https://evil.example/</loc></url> -->\n'.repeat(1000);
  const doc = `<!DOCTYPE urlset [\n${subset}]>\n<urlset><url><loc>https://a.com/1</loc></url></urlset>`;

  it('discards the whole 70 KB internal subset after the error, at any chunk size', () => {
    expect(subset.length).toBeGreaterThan(70_000);
    const whole = run(doc, doc.length);
    for (const size of [1, 7, 1000, 4096, 65_536, 65_537, doc.length]) {
      const t = run(doc, size);
      expect(t, `size ${size}`).toEqual(whole);
      expect(unlined(t.tokens.filter((x) => x.type === 'error')), `size ${size}`).toEqual([error('unterminated-declaration', UNTERMINATED_DECLARATION)]);
      expect(t.tokens.filter((x) => x.type === 'open').map((x) => (x as { name: string }).name), `size ${size}`).toEqual(['urlset', 'url', 'loc']);
      expect(t.tokens.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text), `size ${size}`).toEqual(['https://a.com/1']);
    }
  });

  it('reports a DOCTYPE that never ends once, at the end of the document too', () => {
    expect(unlined(run(`<!DOCTYPE urlset [${subset}`, 5000).tokens)).toEqual([error('unterminated-declaration', UNTERMINATED_DECLARATION)]);
  });
});

describe('character references', () => {
  it('does not decode references to characters XML forbids', () => {
    const forbidden = ['&#0;', '&#x0;', '&#xFFFE;', '&#xFFFF;', '&#xD800;', '&#xDFFF;', '&#55357;', '&#x110000;', '&#1;', '&#x1F;', '&#xB;'];
    for (const ref of forbidden) {
      expect(decodeEntities(ref), ref).toBe(ref);
      const tk = tokenizer();
      expect(unlined(tk.write(`<loc>a${ref}b</loc>`)), ref).toEqual([open('loc'), text(`a${ref}b`), close('loc')]);
      expect(tk.bareAmpersands, ref).toBe(1);
    }
    expect(decodeEntities('&#xD800;&#xDFFF;')).toBe('&#xD800;&#xDFFF;');
  });

  it('decodes tab, line feed, carriage return and the astral range', () => {
    expect(decodeEntities('&#9;&#10;&#13;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;')).toBe('\t\n\r \ud7ff\ue000\ufffd\u{10000}\u{10ffff}');
  });

  it('decodes zero-padded references up to the length cap and refuses longer ones', () => {
    const padded = (digits: number) => `&#${'0'.repeat(digits - 2)}38;`; // digits = chars between "&#" and ";"
    expect(decodeEntities(padded(21))).toBe('&');
    expect(decodeEntities(padded(22))).toBe(padded(22));
    expect(decodeEntities(`&#x${'0'.repeat(18)}26;`)).toBe('&');
    expect(decodeEntities(`&#x${'0'.repeat(19)}26;`)).toBe(`&#x${'0'.repeat(19)}26;`);
    expect(decodeEntities(`&${'a'.repeat(23)};`)).toBe(`&${'a'.repeat(23)};`);
  });

  it('decodes a long padded reference the same wherever the chunks split', () => {
    const doc = `<loc>https://a.com/?a=1&#${'0'.repeat(19)}38;b=2&#${'0'.repeat(25)}38;</loc>`;
    const whole = run(doc, doc.length);
    expect(whole.tokens[1]).toMatchObject({ text: `https://a.com/?a=1&b=2&#${'0'.repeat(25)}38;` });
    expect(whole.bare).toBe(1);
    for (let size = 1; size <= 41; size++) expect(run(doc, size), `size ${size}`).toEqual(whole);
  });
});

describe('xml declaration', () => {
  it('reports a declared encoding once, from the first construct only', () => {
    expect(run('<?xml version="1.0" encoding="ISO-8859-1"?><a/>', 100).tokens[0]).toEqual({ type: 'xmldecl', encoding: 'ISO-8859-1', line: 1 });
    expect(run("\ufeff\n<?xml version='1.0' encoding = 'utf-16' standalone='yes'?><a/>", 100).tokens[0]).toEqual({ type: 'xmldecl', encoding: 'utf-16', line: 2 });
    expect(all(['<?xml version="1.0"?><a/>']).map((x) => x.type)).toEqual(['open']);
    expect(all(['<a/><?xml version="1.0" encoding="latin1"?>']).map((x) => x.type)).toEqual(['open']);
    expect(all(['<?xml-stylesheet encoding="x"?><a/>']).map((x) => x.type)).toEqual(['open']);
  });
});

describe('line numbers', () => {
  it('numbers a token that joins a full row by the next row, in step with the stored pieces', () => {
    // <a> and the text fill the row to exactly MAX_XML_LINE characters, so </a> starts the next piece
    const { tokens, rows } = run(`<a>${'x'.repeat(MAX_XML_LINE - 3)}</a><c/>`, 1000);
    expect(rows.map((r) => r.length)).toEqual([MAX_XML_LINE, 4, 4]);
    expect(tokens.map((x) => [x.type, x.line])).toEqual([['open', 1], ['text', 1], ['close', 2], ['open', 3]]);
    const full = run(`${'x'.repeat(MAX_XML_LINE)}\n<c/>`, 1000); // exactly full: no extra piece
    expect(full.rows.map((r) => r.length)).toEqual([MAX_XML_LINE, 4]);
    expect(full.tokens.find((x) => x.type === 'open')).toMatchObject({ line: 2 });
  });
});

describe('line of a token after a skipped construct', () => {
  // the construct's rows, then the row holding `needle`, which the first token after <a> must point at
  const cases: [string, string, string, number][] = [
    ['a comment', '<a><!--\n\n\n--><b/></a>', '<b/>', 6],
    ['a processing instruction', '<a><?pi\n?><b/></a>', '<b/>', 4],
    ['a DOCTYPE', '<!DOCTYPE a [\n]><b/>', '<b/>', 3],
    ['a comment, before a CDATA section', '<a><!--\n--><![CDATA[x]]></a>', '<![CDATA[', 4],
    ['a comment, before text', '<a><!--\n\n-->tail</a>', 'tail', 5],
    ['a comment, before a closing tag', '<!--\n--></x>', '</x>', 3],
  ];
  for (const [name, doc, needle, line] of cases) {
    it(`starts on the row after ${name} that spans lines`, () => {
      for (const size of [doc.length, 1, 3]) {
        const { tokens, rows } = run(doc, size);
        const first = tokens.find((x) => !('name' in x && x.name === 'a'));
        expect(first?.line, `size ${size}`).toBe(line);
        expect(lineOf(rows, needle), `size ${size}`).toBe(line);
      }
    });
  }
});

describe('chunk independence', () => {
  const fixtures = readdirSync('test/fixtures', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => [e.name, readFileSync(`test/fixtures/${e.name}`, 'utf8')] as const);
  const synthetic: [string, string][] = [
    ['entities', '<urlset><url><loc>https://a.com/?a=1&b=2&amp;c=3&#38;d&#x26;e&#0;f&#xD800;g&#00000000000000000000038;h&bogus;i&amp</loc></url></urlset>'],
    ['attributes', '<urlset xmlns:x="u&v"><url><xhtml:link rel="alternate" href="https://a.com/?a=1&b=2" x=\'a<b\'/><loc>a</loc></url></urlset>'],
    ['doctype', `<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE urlset [\n<!-- it's -->\n<!ENTITY e "x><y>">\n]>\n<urlset>\n<url><loc>https://a.com/</loc></url></urlset>`],
    ['cdata-comment-pi', '<?xml version="1.0"?>\n<!-- c1\nc2 --><a><![CDATA[x<y&z]]>t<?pi x?>u</a>\n<!DOCTYPE'],
    ['multibyte', '<a>é𝄞日本語 &amp; 𝄞</a>\n<b>\u{10FFFF}</b>'],
    ['long-line', `<urlset>${Array.from({ length: 900 }, (_, i) => `<url><loc>https://a.com/${i}?x=1&amp;y=2</loc></url>`).join('')}\n<url/></urlset>`],
  ];
  it('has fixture files to compare', () => {
    expect(fixtures.map(([name]) => name).sort()).toEqual(['broken.xml', 'empty.xml', 'hreflang.xml', 'images.xml', 'index.xml', 'not-sitemap.html', 'valid-small.xml']);
  });

  for (const [name, doc] of [...fixtures, ...synthetic]) {
    it(`gives the same tokens, ampersand count and rows at every chunk size 1..41 (${name})`, () => {
      const whole = run(doc, doc.length);
      for (let size = 1; size <= 41; size++) expect(run(doc, size), `${name} at ${size}`).toEqual(whole);
    });
  }

  describe('the whole-document reading the chunk sizes are compared with', () => {
    const whole = (name: string) => run(synthetic.find(([n]) => n === name)![1], 1_000_000);

    it('decodes valid references, leaves the rest literal and counts them as bare ampersands', () => {
      const r = whole('entities');
      expect(r.tokens[3]).toMatchObject(text('https://a.com/?a=1&b=2&c=3&d&e&#0;f&#xD800;g&#00000000000000000000038;h&bogus;i&amp'));
      expect(r.bare).toBe(6); // &b, &#0;, &#xD800;, the over-long &#000…38;, &bogus; and the unfinished &amp
    });

    it('counts the ampersands of attribute values and reports a raw "<" in one', () => {
      const r = whole('attributes');
      expect(r.tokens[0]).toMatchObject(open('urlset', { 'xmlns:x': 'u&v' }));
      expect(r.tokens[2]).toMatchObject({ type: 'error', code: 'malformed-tag', line: 3 });
      expect(r.tokens[3]).toMatchObject(open('xhtml:link', { rel: 'alternate', href: 'https://a.com/?a=1&b=2', x: 'a<b' }, true));
      expect(r.bare).toBe(2);
    });

    it('reads the declaration, skips the DOCTYPE with its subset and numbers the lines', () => {
      const r = whole('doctype');
      expect(r.rows).toEqual([
        '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE urlset [', "<!-- it's -->", '<!ENTITY e "x><y>">', ']>',
        '<urlset>', '  <url>', '    <loc>https://a.com/</loc>', '  </url>', '</urlset>',
      ]);
      expect(r.tokens.map((t) => [t.type, t.line])).toEqual([
        ['xmldecl', 1], ['open', 6], ['open', 7], ['open', 8], ['text', 8], ['close', 8], ['close', 9], ['close', 10],
      ]);
    });

    it('keeps CDATA, comment and processing instruction boundaries apart, and reports a DOCTYPE cut off by the end', () => {
      expect(unlined(whole('cdata-comment-pi').tokens)).toEqual([
        open('a', {}), text('x<y&z'), text('t'), text('u'), close('a'), error('unterminated-declaration', UNTERMINATED_DECLARATION),
      ]);
    });

    it('keeps multibyte text and an astral character whole', () => {
      expect(unlined(whole('multibyte').tokens)).toEqual([open('a'), text('é𝄞日本語 & 𝄞'), close('a'), open('b', {}), text('\u{10FFFF}'), close('b')]);
    });
  });
});
