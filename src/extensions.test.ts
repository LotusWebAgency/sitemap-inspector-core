import { describe, expect, it } from 'vitest';
import { capValue, ExtensionCollector, EXAMPLE_MAX, IMAGE_NS, invalidValueExample, MAX_EXT_HITS_PER_URL, MOBILE_NS, NEWS_NS, newsLanguage, tooLongExample, tooManyExample, unknownExtensionNamespace, VIDEO_NS, XHTML_NS } from './extensions.js';

describe('ExtensionCollector', () => {
  it('reports deprecated image tags and mobile tags once per url, and resets on endUrl', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'caption', 4);
    c.open(IMAGE_NS, 'caption', 5);
    c.open(IMAGE_NS, 'loc', 5);
    c.open(MOBILE_NS, 'mobile', 6);
    c.open(undefined, 'caption', 7);
    expect(c.endUrl()).toEqual([
      { rule: 'image-deprecated-field', line: 4, value: 'image:caption' },
      { rule: 'mobile-obsolete', line: 6 },
    ]);
    c.open(IMAGE_NS, 'caption', 9);
    expect(c.endUrl()).toEqual([{ rule: 'image-deprecated-field', line: 9, value: 'image:caption' }]);
  });

  it('keeps every hit up to the per-url cap and drops the ones after it, and starts the next url empty', () => {
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);
    const exact = new ExtensionCollector();
    for (let i = 0; i < MAX_EXT_HITS_PER_URL; i++) exact.emit('mobile-obsolete', i);
    expect(exact.endUrl().map((h) => h.line)).toEqual(upTo(MAX_EXT_HITS_PER_URL));
    const over = new ExtensionCollector();
    for (let i = 0; i < MAX_EXT_HITS_PER_URL + 1; i++) over.emit('mobile-obsolete', i);
    expect(over.endUrl().map((h) => h.line)).toEqual(upTo(MAX_EXT_HITS_PER_URL)); // the first ones stay
    expect(over.endUrl()).toEqual([]);
    over.emit('mobile-obsolete', 99);
    expect(over.endUrl()).toEqual([{ rule: 'mobile-obsolete', line: 99 }]);
  });

  it('keeps a value and string params of exactly the example cap whole, and cuts one past it, when a hit is created', () => {
    const c = new ExtensionCollector();
    c.emit('mobile-obsolete', 1, { value: 'x'.repeat(EXAMPLE_MAX), params: { tag: 'y'.repeat(EXAMPLE_MAX), n: 5000 } });
    c.emit('mobile-obsolete', 2, { value: 'x'.repeat(EXAMPLE_MAX + 1), params: { tag: 'y'.repeat(EXAMPLE_MAX + 1), n: 5000 } });
    c.emit('mobile-obsolete', 3, { value: 'x'.repeat(5000), params: { tag: 'y'.repeat(5000), n: 5000 } });
    expect(c.endUrl()).toEqual([
      { rule: 'mobile-obsolete', line: 1, value: 'x'.repeat(EXAMPLE_MAX), params: { tag: 'y'.repeat(EXAMPLE_MAX), n: 5000 } },
      { rule: 'mobile-obsolete', line: 2, value: 'x'.repeat(EXAMPLE_MAX) + '…', params: { tag: 'y'.repeat(EXAMPLE_MAX) + '…', n: 5000 } },
      { rule: 'mobile-obsolete', line: 3, value: 'x'.repeat(EXAMPLE_MAX) + '…', params: { tag: 'y'.repeat(EXAMPLE_MAX) + '…', n: 5000 } },
    ]);
  });

  it('capValue leaves EXAMPLE_MAX characters alone and cuts the next one to EXAMPLE_MAX plus an ellipsis', () => {
    expect(capValue('')).toBe('');
    expect(capValue('x'.repeat(EXAMPLE_MAX))).toBe('x'.repeat(EXAMPLE_MAX));
    expect(capValue('x'.repeat(EXAMPLE_MAX + 1))).toBe('x'.repeat(EXAMPLE_MAX) + '…');
  });

  it('words the too-many example in English, with its params', () => {
    expect(tooManyExample('image:image', 1001, 1000)).toEqual({
      value: '1,001 <image:image> elements (limit 1,000)', code: 'ext-too-many', params: { field: 'image:image', count: 1001, max: 1000 },
    });
  });

  it('words the too-long and invalid-value examples in English, with their params', () => {
    expect(tooLongExample('video:description', 2113, 2048)).toEqual({
      value: '<video:description> is 2,113 characters (limit 2,048)', code: 'ext-too-long', params: { field: 'video:description', length: 2113, max: 2048 },
    });
    expect(invalidValueExample('video:rating', '7')).toEqual({
      value: '<video:rating>: "7"', code: 'ext-invalid-value', params: { field: 'video:rating', value: '7' },
    });
  });
});

describe('newsLanguage', () => {
  it('accepts ISO 639 codes of two or three letters and zh-cn / zh-tw, in any case', () => {
    for (const v of ['en', 'EN', 'fil', 'zh-cn', 'ZH-TW']) expect(newsLanguage(v), v).toBe(true);
    for (const v of ['english', 'zz', 'en-us', 'zh-hk', '']) expect(newsLanguage(v), v).toBe(false);
  });
});

describe('ExtensionCollector news blocks', () => {
  const NOW = Date.parse('2026-08-27T12:00:00Z');
  const field = (c: ExtensionCollector, name: string, text: string, line = 2) => {
    c.open(NEWS_NS, name, line); c.text(text); c.close(NEWS_NS, name);
  };

  it('checks a block on its close and counts it', () => {
    const c = new ExtensionCollector(NOW);
    expect(c.blockCount('news')).toBe(0);
    c.open(NEWS_NS, 'news', 2);
    field(c, 'title', 'T');
    expect(c.blockCount('news')).toBe(1);
    c.close(NEWS_NS, 'news');
    expect(c.blockCount('news')).toBe(1);
    expect(c.blockCount('video')).toBe(0);
    expect(c.endUrl().map((h) => [h.rule, h.value, h.line])).toEqual([
      ['news-missing-field', 'news:publication', 2], ['news-missing-field', 'news:name', 2],
      ['news-missing-field', 'news:language', 2], ['news-missing-field', 'news:publication_date', 2],
    ]);
  });

  it('judges a publication date against the clock the collector was given, two days back being the limit', () => {
    const hitsAt = (now: number, date: string) => {
      const c = new ExtensionCollector(now);
      c.open(NEWS_NS, 'news', 2);
      c.open(NEWS_NS, 'publication', 2); field(c, 'name', 'Daily'); field(c, 'language', 'en'); c.close(NEWS_NS, 'publication');
      field(c, 'publication_date', date); field(c, 'title', 'T');
      c.close(NEWS_NS, 'news');
      return c.endUrl().map((h) => [h.rule, h.value]);
    };
    expect(new ExtensionCollector(NOW).now).toBe(NOW);
    expect(hitsAt(NOW, '2026-08-25T12:00:00Z')).toEqual([]); // exactly two days old
    expect(hitsAt(NOW, '2026-08-25T11:59:59Z')).toEqual([['news-too-old', '2026-08-25T11:59:59Z']]);
    expect(hitsAt(NOW + 1000, '2026-08-25T12:00:00Z')).toEqual([['news-too-old', '2026-08-25T12:00:00Z']]); // the same date, a later clock
    expect(hitsAt(NOW - 86_400_000, '2026-08-25T11:59:59Z')).toEqual([]);
    expect(hitsAt(NOW, '2026-08')).toEqual([['news-invalid-date', '2026-08']]);
  });

  it('keeps the first occurrence of a field and caps its text', () => {
    const c = new ExtensionCollector(NOW);
    c.open(NEWS_NS, 'news', 2);
    c.open(NEWS_NS, 'publication', 2);
    field(c, 'name', 'Daily');
    field(c, 'language', 'x'.repeat(5000));
    field(c, 'language', 'en');
    c.close(NEWS_NS, 'publication');
    field(c, 'publication_date', '2026-08-26');
    field(c, 'title', 'T');
    c.close(NEWS_NS, 'news');
    expect(c.endUrl().map((h) => [h.rule, h.value])).toEqual([['news-invalid-language', 'x'.repeat(EXAMPLE_MAX) + '…']]);
  });

  it('ignores news tags bound to another namespace and text outside a captured field', () => {
    const c = new ExtensionCollector(NOW);
    c.open(NEWS_NS, 'news', 2);
    c.open('https://example.com/other', 'title', 2); c.text('ignored'); c.close('https://example.com/other', 'title');
    c.text('stray');
    c.close(NEWS_NS, 'news');
    expect(c.endUrl().map((h) => h.value)).toEqual(['news:publication', 'news:name', 'news:language', 'news:publication_date', 'news:title']);
  });
});

describe('video blocks', () => {
  // Opens a <video:video> on line 3, adds each field with its text, closes it and returns the url's hits.
  const video = (fields: [string, string][]) => {
    const c = new ExtensionCollector(0);
    c.open(VIDEO_NS, 'video', 3);
    for (const [name, text] of fields) { c.open(VIDEO_NS, name, 4); c.text(text); c.close(VIDEO_NS, name); }
    c.close(VIDEO_NS, 'video');
    return c.endUrl();
  };
  const VALID: [string, string][] = [['thumbnail_loc', 'https://a.com/t.jpg'], ['title', 'T'], ['description', 'D'], ['content_loc', 'https://a.com/v.mp4']];
  const invalidCount = (name: string, v: string) => video([...VALID, [name, v]]).filter((h) => h.rule === 'video-invalid-value').length;

  it('accepts a minimal valid video, with player_loc in place of content_loc too', () => {
    expect(video(VALID)).toEqual([]);
    expect(video([...VALID.slice(0, 3), ['player_loc', 'https://a.com/p']])).toEqual([]);
  });

  it('reports each missing or empty required tag and the missing content/player pair', () => {
    expect(video([['title', ' ']]).map((h) => [h.rule, h.value, h.line])).toEqual([
      ['video-missing-field', 'video:thumbnail_loc', 3], ['video-missing-field', 'video:title', 3],
      ['video-missing-field', 'video:description', 3], ['video-missing-field', 'video:content_loc / video:player_loc', 3],
    ]);
  });

  it('checks duration, rating, yes/no flags, dates and uploader length', () => {
    const bad: [string, string][] = [
      ['duration', '0'], ['duration', '28801'], ['duration', '12.5'], ['duration', ''],
      ['rating', '5.1'], ['rating', '5.000001'], ['rating', '-1'], ['rating', 'five'], ['rating', ''],
      ['family_friendly', 'true'], ['live', ''], ['requires_subscription', 'Y'],
      ['publication_date', '2026-13-01'], ['expiration_date', 'tomorrow'], ['uploader', 'u'.repeat(256)],
    ];
    const good: [string, string][] = [
      ['duration', '1'], ['duration', '28800'], ['rating', '0'], ['rating', '4.5'], ['rating', '5.0'],
      ['family_friendly', 'YES'], ['live', 'no'], ['publication_date', '2026-08-01T10:00:00+02:00'], ['uploader', 'u'.repeat(255)],
    ];
    for (const [name, v] of bad) expect(invalidCount(name, v), `${name}=${v.slice(0, 20)}`).toBe(1);
    for (const [name, v] of good) expect(invalidCount(name, v), `${name}=${v.slice(0, 20)}`).toBe(0);
    expect(video([...VALID, ['rating', '7']])).toEqual([{
      rule: 'video-invalid-value', line: 3, value: '<video:rating>: "7"', code: 'ext-invalid-value', params: { field: 'video:rating', value: '7' },
    }]);
  });

  it('reports the full length of a huge description and counts every tag past 32', () => {
    const c = new ExtensionCollector(0);
    c.open(VIDEO_NS, 'video', 3);
    for (const [name, text] of VALID) {
      c.open(VIDEO_NS, name, 4);
      if (name === 'description') for (let i = 0; i < 100; i++) c.text('x'.repeat(1000));
      else c.text(text);
      c.close(VIDEO_NS, name);
    }
    for (let i = 0; i < 40; i++) { c.open(VIDEO_NS, 'tag', 5); c.text(`t${i}`); c.close(VIDEO_NS, 'tag'); }
    c.close(VIDEO_NS, 'video');
    expect(c.endUrl().map((h) => h.value)).toEqual(['<video:description> is 100,000 characters (limit 2,048)', '40 <video:tag> elements (limit 32)']);
  });

  it('flags a description only past 2,048 chars', () => {
    const withDescription = (n: number) => video([...VALID.map(([k, v]): [string, string] => (k === 'description' ? [k, 'x'.repeat(n)] : [k, v]))]);
    expect(withDescription(2048)).toEqual([]);
    expect(withDescription(2049).map((h) => [h.rule, h.value])).toEqual([['video-invalid-value', '<video:description> is 2,049 characters (limit 2,048)']]);
  });

  it('flags tags only past 32 elements', () => {
    const withTags = (n: number) => video([...VALID, ...Array.from({ length: n }, (_, i): [string, string] => ['tag', `t${i}`])]);
    expect(withTags(32)).toEqual([]);
    expect(withTags(33).map((h) => [h.rule, h.value])).toEqual([['video-invalid-value', '33 <video:tag> elements (limit 32)']]);
  });

  it('needs a full date in publication_date and expiration_date', () => {
    for (const name of ['publication_date', 'expiration_date']) {
      for (const v of ['2026', '2026-08']) expect(invalidCount(name, v), `${name}=${v}`).toBe(1);
      for (const v of ['2026-08-01', '2026-08-01T10:00:00+02:00']) expect(invalidCount(name, v), `${name}=${v}`).toBe(0);
    }
  });

  it('reports a deprecated tag once per url and stays under the per-url hit cap with many broken videos', () => {
    const c = new ExtensionCollector(0);
    for (let i = 0; i < 40; i++) {
      c.open(VIDEO_NS, 'video', 3 + i);
      c.open(VIDEO_NS, 'category', 3 + i); c.text('Demos'); c.close(VIDEO_NS, 'category');
      c.close(VIDEO_NS, 'video');
    }
    const hits = c.endUrl();
    expect(hits).toHaveLength(MAX_EXT_HITS_PER_URL);
    expect(hits.filter((h) => h.rule === 'video-deprecated-field')).toEqual([{ rule: 'video-deprecated-field', line: 3, value: 'video:category' }]);
  });

  it('counts a self-closed first occurrence as an empty value and ignores later ones in the block', () => {
    const c = new ExtensionCollector(0);
    c.open(VIDEO_NS, 'video', 3);
    for (const [name, text] of VALID) {
      if (name === 'title') { c.open(VIDEO_NS, name, 4, true); c.close(VIDEO_NS, name); c.open(VIDEO_NS, name, 5); c.text('Late'); c.close(VIDEO_NS, name); continue; }
      c.open(VIDEO_NS, name, 4); c.text(text); c.close(VIDEO_NS, name);
    }
    c.close(VIDEO_NS, 'video');
    expect(c.endUrl().map((h) => [h.rule, h.value])).toEqual([['video-missing-field', 'video:title']]);
  });
});

describe('unknownExtensionNamespace', () => {
  it('accepts the exact documented bindings', () => {
    for (const [p, u] of [['image', IMAGE_NS], ['video', VIDEO_NS], ['news', NEWS_NS], ['mobile', MOBILE_NS], ['xhtml', XHTML_NS], ['img', IMAGE_NS], ['x', XHTML_NS], ['xsi', 'http://www.w3.org/2001/XMLSchema-instance'], ['p', 'urn:x']] as const) {
      expect(unknownExtensionNamespace(p, u), `${p}=${u}`).toBe(false);
    }
  });

  it('flags a reserved prefix bound to anything else, in any case', () => {
    for (const [p, u] of [['image', 'https://www.google.com/schemas/sitemap-image/1.1'], ['video', 'urn:x'], ['NEWS', ''], ['mobile', IMAGE_NS], ['xhtml', 'http://www.w3.org/1999/XHTML'],
      ['image', 'urn:x'], ['news', 'urn:x'], ['mobile', 'urn:x'], ['xhtml', 'urn:x']] as const) {
      expect(unknownExtensionNamespace(p, u), `${p}=${u}`).toBe(true);
    }
  });

  it('flags any prefix bound to a URI that differs from an exact one by scheme, trailing slash, case or a typo', () => {
    for (const u of ['http://www.google.com/schemas/sitemap-image/1.0', 'http://www.google.com/schemas/sitemap-video/1.0', 'http://www.google.com/schemas/sitemap-news/0.84',
      'http://www.google.com/schemas/sitemap-mobile/1.1', 'https://www.google.com/schemas/sitemap-image/1.1', 'http://www.google.com/schemas/sitemap-image/1.1/',
      'http://www.google.com/Schemas/Sitemap-News/0.9', 'http://www.google.com/schema/sitemap-video/1.1', 'http://www.google.com/schemas/sitemap-imge/1.1',
      'https://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xhtml/', 'http://www.w3.org/1999/XHTML', 'http://www.w3.org/1999/xhtlm']) {
      expect(unknownExtensionNamespace('x', u), u).toBe(true);
    }
  });

  it('leaves other URIs alone, even when they mention xhtml or sitemap', () => {
    for (const u of ['http://www.w3.org/TR/xhtml1/', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/2001/XMLSchema-instance', 'http://example.com/xhtml', 'http://example.com/sitemap-image',
      'http://www.google.com/maps', 'http://www.sitemaps.org/schemas/sitemap/0.9', 'urn:sitemap-image', 'not a uri']) {
      expect(unknownExtensionNamespace('x', u), u).toBe(false);
    }
  });
});

describe('unknownExtensionNamespace host and path', () => {
  it('judges only http(s) URIs on the documented host and path', () => {
    for (const u of ['ftp://www.google.com/schemas/sitemap-image/1.1', 'ftp://www.w3.org/1999/xhtml', 'file://www.google.com/schemas/sitemap-video/1.1']) {
      expect(unknownExtensionNamespace('x', u), u).toBe(false);
    }
  });

  it('needs both /schema... and sitemap in a www.google.com path, and the /1999/xh path on www.w3.org only', () => {
    for (const u of ['http://www.google.com/maps/sitemap', 'http://www.google.com/schemas/other', 'http://www.google.com/other/sitemap-image', 'http://www.google.com/',
      'http://example.com/1999/xhtml', 'http://w3.org/1999/xhtml', 'http://www.w3.org/1998/xhtml']) {
      expect(unknownExtensionNamespace('x', u), u).toBe(false);
    }
    for (const u of ['http://www.google.com/schema/sitemap', 'http://www.google.com/schemas/x/sitemap', 'http://www.w3.org/1999/xh']) {
      expect(unknownExtensionNamespace('x', u), u).toBe(true);
    }
  });
});

describe('ExtensionCollector image urls', () => {
  const loc = (c: ExtensionCollector, text: string, line = 3) => { c.open(IMAGE_NS, 'loc', line); c.text(text); c.close(IMAGE_NS, 'loc'); };

  it('flags an image:loc that is not an absolute http(s) URL, and trims the text it reads', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2); loc(c, ' https://a.com/ok.jpg\n'); c.close(IMAGE_NS, 'image');
    c.open(IMAGE_NS, 'image', 4); loc(c, '/rel.jpg', 5); c.close(IMAGE_NS, 'image');
    c.open(IMAGE_NS, 'image', 6); c.open(IMAGE_NS, 'loc', 7, true); c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([
      { rule: 'invalid-extension-url', line: 5, value: '<image:loc>: "/rel.jpg"', code: 'ext-invalid-value', params: { field: 'image:loc', value: '/rel.jpg' } },
      { rule: 'invalid-extension-url', line: 7, value: '<image:loc>: ""', code: 'ext-invalid-value', params: { field: 'image:loc', value: '' } },
    ]);
  });

  it('flags an <image:image> without an <image:loc>, closed or self-closed', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2); c.open(IMAGE_NS, 'title', 3); c.close(IMAGE_NS, 'title'); c.close(IMAGE_NS, 'image');
    c.open(IMAGE_NS, 'image', 5, true);
    expect(c.endUrl()).toEqual([
      { rule: 'image-deprecated-field', line: 3, value: 'image:title' },
      { rule: 'invalid-extension-url', line: 2, value: '<image:image> has no <image:loc>', code: 'image-without-loc' },
      { rule: 'invalid-extension-url', line: 5, value: '<image:image> has no <image:loc>', code: 'image-without-loc' },
    ]);
  });

  it('forgets an image left open when its <url> ends', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2);
    expect(c.endUrl()).toEqual([]);
    c.open(IMAGE_NS, 'loc', 8); c.text('/x'); // no <image:image> is open: nothing to check
    c.close(IMAGE_NS, 'loc');
    expect(c.endUrl()).toEqual([]);
  });
});

describe('ExtensionCollector video urls', () => {
  it('flags thumbnail, content and player URLs that are present but not http(s), and leaves missing ones to video-missing-field', () => {
    const c = new ExtensionCollector();
    c.open(VIDEO_NS, 'video', 2);
    for (const [name, text] of [['thumbnail_loc', 'data:image/png;base64,xx'], ['title', 'T'], ['description', 'D'], ['content_loc', 'https://a.com/v.mp4'], ['player_loc', 'player']] as const) {
      c.open(VIDEO_NS, name, 3); c.text(text); c.close(VIDEO_NS, name);
    }
    c.close(VIDEO_NS, 'video');
    expect(c.endUrl()).toEqual([
      { rule: 'invalid-extension-url', line: 2, value: '<video:thumbnail_loc>: "data:image/png;base64,xx"', code: 'ext-invalid-value', params: { field: 'video:thumbnail_loc', value: 'data:image/png;base64,xx' } },
      { rule: 'invalid-extension-url', line: 2, value: '<video:player_loc>: "player"', code: 'ext-invalid-value', params: { field: 'video:player_loc', value: 'player' } },
    ]);
  });
});

describe('ExtensionCollector element routing', () => {
  const noLoc = (line: number) => ({ rule: 'invalid-extension-url', line, value: '<image:image> has no <image:loc>', code: 'image-without-loc' });

  it('reports each of the four deprecated image tags, and only in the image namespace', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'caption', 2); c.open(IMAGE_NS, 'title', 3); c.open(IMAGE_NS, 'geo_location', 4); c.open(IMAGE_NS, 'license', 5);
    c.open(IMAGE_NS, 'loc', 6); c.open(VIDEO_NS, 'title', 7); c.open('urn:x', 'license', 8); c.open('urn:x', 'geo_location', 9);
    expect(c.endUrl()).toStrictEqual([
      { rule: 'image-deprecated-field', line: 2, value: 'image:caption' },
      { rule: 'image-deprecated-field', line: 3, value: 'image:title' },
      { rule: 'image-deprecated-field', line: 4, value: 'image:geo_location' },
      { rule: 'image-deprecated-field', line: 5, value: 'image:license' },
    ]);
  });

  it('reports only <mobile:mobile>, not other mobile tags, other namespaces or a mobile tag elsewhere', () => {
    const c = new ExtensionCollector();
    c.open(MOBILE_NS, 'other', 2); c.open('urn:x', 'mobile', 3); c.open(NEWS_NS, 'mobile', 4); c.open(IMAGE_NS, 'mobile', 5); c.open(IMAGE_NS, 'loc', 6);
    expect(c.endUrl()).toStrictEqual([]);
    c.open(MOBILE_NS, 'mobile', 7);
    expect(c.endUrl()).toStrictEqual([{ rule: 'mobile-obsolete', line: 7 }]);
  });

  it('leaves a hit without a code or params as the bare rule, line and value', () => {
    const c = new ExtensionCollector();
    c.emit('mobile-obsolete', 1, { value: 'v' });
    c.emit('mobile-obsolete', 2);
    expect(c.endUrl()).toStrictEqual([{ rule: 'mobile-obsolete', line: 1, value: 'v' }, { rule: 'mobile-obsolete', line: 2 }]);
  });

  it('reads <image:image> and <image:loc> in the image namespace only', () => {
    const c = new ExtensionCollector();
    c.open(VIDEO_NS, 'image', 2, true);
    c.open('urn:x', 'image', 3, true);
    expect(c.endUrl()).toEqual([]);
    c.open(IMAGE_NS, 'image', 4);
    c.open('urn:x', 'loc', 5, true);
    c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([noLoc(4)]);
  });

  it('ignores an image tag closed in another namespace', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2);
    c.close('urn:x', 'image');
    c.open(IMAGE_NS, 'loc', 3); c.text('/a'); c.close('urn:x', 'loc'); c.text('/b'); c.close(IMAGE_NS, 'loc');
    c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([
      { rule: 'invalid-extension-url', line: 3, value: '<image:loc>: "/a/b"', code: 'ext-invalid-value', params: { field: 'image:loc', value: '/a/b' } },
    ]);
  });

  it('keeps an image open while its other child tags close', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2);
    c.open(IMAGE_NS, 'caption', 3); c.close(IMAGE_NS, 'caption');
    c.open(IMAGE_NS, 'loc', 4); c.text('https://a.com/ok.jpg'); c.close(IMAGE_NS, 'loc');
    c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([{ rule: 'image-deprecated-field', line: 3, value: 'image:caption' }]);
  });

  it('trims an invalid image:loc before it becomes the example', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2);
    c.open(IMAGE_NS, 'loc', 3); c.text('  /rel.jpg\n '); c.close(IMAGE_NS, 'loc');
    c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([
      { rule: 'invalid-extension-url', line: 3, value: '<image:loc>: "/rel.jpg"', code: 'ext-invalid-value', params: { field: 'image:loc', value: '/rel.jpg' } },
    ]);
  });

  it('reads only the first 2,048 characters of an image:loc', () => {
    const c = new ExtensionCollector();
    c.open(IMAGE_NS, 'image', 2);
    c.open(IMAGE_NS, 'loc', 3); c.text(' '.repeat(2000)); c.text(' '.repeat(100) + 'https://a.com/x.jpg'); c.close(IMAGE_NS, 'loc');
    c.close(IMAGE_NS, 'image');
    expect(c.endUrl()).toEqual([
      { rule: 'invalid-extension-url', line: 3, value: '<image:loc>: ""', code: 'ext-invalid-value', params: { field: 'image:loc', value: '' } },
    ]);
  });
});

describe('ExtensionCollector blocks', () => {
  const NOW = Date.parse('2026-08-27T12:00:00Z');
  const missingNews = (line: number) => ['news:publication', 'news:name', 'news:language', 'news:publication_date', 'news:title'].map((value) => ({ rule: 'news-missing-field', line, value }));
  const validNews = (c: ExtensionCollector, language: (c: ExtensionCollector) => void) => {
    c.open(NEWS_NS, 'news', 2);
    c.open(NEWS_NS, 'publication', 2);
    c.open(NEWS_NS, 'name', 2); c.text('Daily'); c.close(NEWS_NS, 'name');
    language(c);
    c.close(NEWS_NS, 'publication');
    c.open(NEWS_NS, 'publication_date', 2); c.text('2026-08-26'); c.close(NEWS_NS, 'publication_date');
    c.open(NEWS_NS, 'title', 2); c.text('T'); c.close(NEWS_NS, 'title');
  };

  it('checks and counts a self-closed block at once, so the next block starts clean', () => {
    const c = new ExtensionCollector(NOW);
    c.open(NEWS_NS, 'news', 2, true);
    c.open(NEWS_NS, 'news', 3, true);
    expect(c.blockCount('news')).toBe(2);
    expect(c.endUrl()).toEqual([...missingNews(2), ...missingNews(3)]);
  });

  it('does not end a block or a captured field on a close in another namespace', () => {
    const c = new ExtensionCollector(NOW);
    validNews(c, (k) => { k.open(NEWS_NS, 'language', 2); k.text('e'); k.close('urn:x', 'language'); k.text('n'); k.close(NEWS_NS, 'language'); });
    c.close('urn:x', 'news');
    c.open(NEWS_NS, 'title', 3); c.text('Second'); c.close(NEWS_NS, 'title');
    c.close(NEWS_NS, 'news');
    expect(c.blockCount('news')).toBe(1);
    expect(c.endUrl()).toEqual([]);
  });

  it('stops capturing text once the field has closed', () => {
    const c = new ExtensionCollector(NOW);
    validNews(c, (k) => { k.open(NEWS_NS, 'language', 2); k.text('en'); k.close(NEWS_NS, 'language'); k.text(' stray'); });
    c.close(NEWS_NS, 'news');
    expect(c.endUrl()).toEqual([]);
  });

  it('reads only the first 2,048 characters of a block field', () => {
    const c = new ExtensionCollector(0);
    c.open(VIDEO_NS, 'video', 3);
    for (const [name, text] of [['thumbnail_loc', 'https://a.com/t.jpg'], ['title', 'T'], ['description', 'D'], ['content_loc', 'https://a.com/v.mp4']]) {
      c.open(VIDEO_NS, name!, 4); c.text(text!); c.close(VIDEO_NS, name!);
    }
    c.open(VIDEO_NS, 'rating', 5); c.text(' '.repeat(2000)); c.text(' '.repeat(100) + '4'); c.close(VIDEO_NS, 'rating');
    c.close(VIDEO_NS, 'video');
    expect(c.endUrl()).toEqual([{
      rule: 'video-invalid-value', line: 3, value: '<video:rating>: ""', code: 'ext-invalid-value', params: { field: 'video:rating', value: '' },
    }]);
  });
});

describe('video value examples', () => {
  const video = (fields: [string, string][]) => {
    const c = new ExtensionCollector(0);
    c.open(VIDEO_NS, 'video', 3);
    for (const [name, text] of [['thumbnail_loc', 'https://a.com/t.jpg'], ['title', 'T'], ['description', 'D'], ['content_loc', 'https://a.com/v.mp4'], ...fields]) {
      c.open(VIDEO_NS, name!, 4); c.text(text!); c.close(VIDEO_NS, name!);
    }
    c.close(VIDEO_NS, 'video');
    return c.endUrl();
  };
  const invalid = (field: string, value: string) => ({ rule: 'video-invalid-value', line: 3, value: `<video:${field}>: "${value}"`, code: 'ext-invalid-value', params: { field: `video:${field}`, value } });

  it('names the field and value of each invalid yes/no flag and date', () => {
    expect(video([['family_friendly', 'maybe'], ['requires_subscription', 'x'], ['live', 'soon']])).toEqual([
      invalid('family_friendly', 'maybe'), invalid('requires_subscription', 'x'), invalid('live', 'soon'),
    ]);
    expect(video([['publication_date', 'yesterday'], ['expiration_date', '2026-13-45']])).toEqual([invalid('publication_date', 'yesterday'), invalid('expiration_date', '2026-13-45')]);
  });

  it('accepts exactly yes or no, in any case, and nothing around them', () => {
    expect(video([['family_friendly', 'Yes'], ['requires_subscription', 'NO'], ['live', 'no']])).toEqual([]);
    for (const v of ['yesterday', 'nothing', 'casino', 'noyes', 'yes no', 'eyes']) expect(video([['live', v]]), v).toEqual([invalid('live', v)]);
  });

  it('accepts a rating of up to two integer digits and six decimals, nothing around the number', () => {
    for (const v of ['05', '00.5', '4.55', '4.123456', '0.000001']) expect(video([['rating', v]]), v).toEqual([]);
    for (const v of ['0x1', '1e0', '0b1', '4.1234567', '100', '10', '1.', '.5', '4abc', 'abc4']) expect(video([['rating', v]]), v).toEqual([invalid('rating', v)]);
  });

  it('measures the uploader trimmed while it fits the cap, and raw once it does not', () => {
    expect(video([['uploader', ' '.repeat(10) + 'u'.repeat(250)]])).toEqual([]);
    expect(video([['uploader', ' '.repeat(1800) + 'u'.repeat(248)]])).toEqual([]); // 2,048 raw characters
    expect(video([['uploader', 'u'.repeat(256)]])).toEqual([{ rule: 'video-invalid-value', line: 3, ...tooLongExample('video:uploader', 256, 255) }]);
    expect(video([['uploader', ' '.repeat(1800) + 'u'.repeat(249)]])).toEqual([{ rule: 'video-invalid-value', line: 3, ...tooLongExample('video:uploader', 2049, 255) }]);
  });
});
