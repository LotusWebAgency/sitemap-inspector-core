import { describe, expect, it } from 'vitest';
import { aliasSiteUrl, cleanHintUrl, isHttpUrl, looksLikeSitemapUrl, normalizeSitemapUrl } from './url.js';

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://a.com/x')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
  });
  it('rejects other schemes and non-urls', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,x')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('ftp://a.com/sitemap.xml')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('isHttpUrl and wildcard hosts', () => {
  it('rejects a host with * (a Grant button would request it as a host permission pattern)', () => {
    expect(isHttpUrl('https://*/s.xml')).toBe(false);
    expect(isHttpUrl('https://*.example.com/s.xml')).toBe(false);
    expect(isHttpUrl('http://a.*.com/s.xml')).toBe(false);
    expect(isHttpUrl('https://a.com/*.xml')).toBe(true); // a * in the path is only a path
  });
});

describe('normalizeSitemapUrl', () => {
  it('drops userinfo and the fragment, keeping the rest', () => {
    expect(normalizeSitemapUrl('https://user:pass@a.com/s.xml?x=1#frag')).toBe('https://a.com/s.xml?x=1');
    expect(normalizeSitemapUrl('https://user@a.com')).toBe('https://a.com/');
  });
  it('is null for anything that is not an http(s) URL with a plain host', () => {
    for (const u of ['javascript:alert(1)', 'ftp://a.com/s.xml', 'not a url', '', 'https://*/s.xml', 'https://*.bank.com/s.xml']) expect(normalizeSitemapUrl(u), u).toBeNull();
  });
});

describe('cleanHintUrl', () => {
  it('drops the fragment and any userinfo, keeping path and query', () => {
    expect(cleanHintUrl('https://u:p@a.com/s.xml?x=1#top')).toBe('https://a.com/s.xml?x=1');
    expect(cleanHintUrl('https://user@a.com/s.xml')).toBe('https://a.com/s.xml');
  });
  it('returns a non-url unchanged', () => {
    expect(cleanHintUrl('not a url')).toBe('not a url');
  });
});

describe('looksLikeSitemapUrl', () => {
  it('accepts xml, xml.gz and sitemap-named urls', () => {
    for (const u of ['https://a.com/sitemap.xml', 'https://a.com/feeds/x.xml.gz', 'https://a.com/FEEDS/X.XML', 'https://a.com/index.php?sitemap=1', 'https://a.com/Sitemap/en', 'https://a.com/?type=SiteMap', 'https://a.com/?page=sitemap', 'https://a.com/?SitemapIndex=2', 'https://a.com/?type=sitemap-news.v2', 'https://a.com/map.xml;jsessionid=1']) {
      expect(looksLikeSitemapUrl(u), u).toBe(true);
    }
  });
  it('rejects ordinary pages and single-use links', () => {
    for (const u of ['https://a.com/account/reset?token=abc', 'https://a.com/', 'https://a.com/blog/post', 'https://a.com/a.xml/page', 'https://a.com/account/reset?token=x&next=/sitemap', 'https://a.com/?q=my-sitemap', 'https://a.com/account/reset?token=x&next=sitemap.xml', 'https://a.com/account/reset?token=abc&sitemap=1', 'https://a.com/account/reset?token=abc&x=sitemap', 'https://a.com/reset;sitemap?token=x', 'not a url',
      'https://a.com/p?x=sitemap/evil', 'https://a.com/p?x=sitemap%20x', 'https://a.com/p?x=sitemap!']) {
      expect(looksLikeSitemapUrl(u), u).toBe(false);
    }
  });
});

describe('aliasSiteUrl', () => {
  const origin = 'http://x.localhost:1';
  const aliases = ['https://example.com'];
  it('moves an alias url onto the scan origin, path, query and fragment kept', () => {
    expect(aliasSiteUrl(new URL('https://example.com/a?b=1#c'), origin, aliases).href).toBe('http://x.localhost:1/a?b=1#c');
  });
  it('leaves other urls and a missing alias list alone', () => {
    const u = new URL('https://other.com/a');
    expect(aliasSiteUrl(u, origin, aliases)).toBe(u);
    expect(aliasSiteUrl(new URL('https://example.com/a'), origin, undefined).href).toBe('https://example.com/a');
  });
  it('returns the very same url when it is already on the scan origin, even if that origin is listed as an alias', () => {
    const u = new URL('http://x.localhost:1/a?b=1');
    expect(aliasSiteUrl(u, origin, [origin])).toBe(u);
    expect(aliasSiteUrl(u, origin, [origin, ...aliases])).toBe(u);
    const v = new URL('https://example.com/a');
    expect(aliasSiteUrl(v, origin, [])).toBe(v);
  });
  it('drops userinfo of the alias url and keeps path, query and fragment', () => {
    expect(aliasSiteUrl(new URL('https://user:pw@example.com/x?q=1#h'), origin, aliases).href).toBe('http://x.localhost:1/x?q=1#h');
    expect(aliasSiteUrl(new URL('https://u@example.com'), origin, aliases).href).toBe('http://x.localhost:1/');
  });
  it('keeps a path that starts with two slashes on the scan origin', () => {
    expect(aliasSiteUrl(new URL('https://example.com//evil.test/x'), origin, aliases).href).toBe('http://x.localhost:1//evil.test/x');
  });
  it('returns the url unchanged when the scan origin cannot take its path', () => {
    const u = new URL('https://example.com/a?b=1');
    expect(aliasSiteUrl(u, 'not an origin', aliases)).toBe(u);
  });
});
