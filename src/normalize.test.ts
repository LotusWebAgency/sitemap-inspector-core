import { describe, expect, it } from 'vitest';
import { duplicateKey, normalizeParsed, normalizeUrl, parsedLoc, rememberParsedLoc } from './normalize.js';

describe('normalizeUrl', () => {
  it('lowercases scheme and host, strips default port and fragment', () => {
    expect(normalizeUrl('HTTPS://Example.com:443/Page#top')).toBe('https://example.com/Page');
    expect(normalizeUrl('http://a.com:80/')).toBe('http://a.com/');
  });
  it('collapses trailing slash except root', () => {
    expect(normalizeUrl('https://a.com/x/')).toBe('https://a.com/x');
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
    expect(normalizeUrl('https://a.com')).toBe('https://a.com/');
  });
  it('keeps query, preserves path case, keeps non-default port', () => {
    expect(normalizeUrl('https://a.com/x/?b=2')).toBe('https://a.com/x?b=2');
    expect(normalizeUrl('https://a.com:8443/x')).toBe('https://a.com:8443/x');
  });
  it('returns null for garbage and for anything but http(s)', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('ftp://a.com/a')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
  });
  it('drops a fragment after a query and keeps the query', () => {
    expect(normalizeUrl('https://a.com/x?b=2#f')).toBe('https://a.com/x?b=2');
  });
  it('folds a fragment and one trailing slash for the "same page" checks, and only one slash', () => {
    expect(normalizeUrl('https://a.com/a#x')).toBe('https://a.com/a');
    expect(normalizeUrl('https://a.com/a/')).toBe('https://a.com/a');
    expect(normalizeUrl('https://a.com/a//')).toBe('https://a.com/a/');
    expect(normalizeParsed(new URL('https://a.com/a/#x'))).toBe('https://a.com/a');
    expect(normalizeParsed(new URL('ftp://a.com/a'))).toBeNull();
  });
});

describe('duplicateKey', () => {
  const key = (u: string) => duplicateKey(new URL(u));

  it('keeps /a, /a/ and /a#x apart', () => {
    expect([key('https://a.com/a'), key('https://a.com/a/'), key('https://a.com/a#x'), key('https://a.com/a?x=1')]).toEqual([
      'https://a.com/a', 'https://a.com/a/', 'https://a.com/a#x', 'https://a.com/a?x=1',
    ]);
  });

  it('folds only what the URL parser folds: scheme and host case, the default port, dot segments, unescaped characters', () => {
    expect(key('HTTPS://A.com:443/a')).toBe('https://a.com/a');
    expect(key('http://a.com:80/a')).toBe('http://a.com/a');
    expect(key('https://a.com:8443/a')).not.toBe(key('https://a.com/a'));
    expect(key('https://a.com/A')).not.toBe(key('https://a.com/a'));
    expect(key('https://a.com')).toBe(key('https://a.com/'));
    expect(key('https://a.com/a/../b/./c')).toBe('https://a.com/b/c');
    expect(key('https://a.com/a b')).toBe('https://a.com/a%20b');
    expect(key('https://a.com/%2f')).toBe('https://a.com/%2f'); // the hex case of an existing escape is not folded
    expect(key('https://a.com/%2F')).toBe('https://a.com/%2F');
  });

  it('has no key for anything but http(s)', () => {
    expect(key('ftp://a.com/a')).toBeNull();
    expect(key('mailto:a@b.c')).toBeNull();
    expect(key('javascript:alert(1)')).toBeNull();
  });
});

describe('parsedLoc', () => {
  it('returns what the parser remembered, and parses on its own for a record it never saw', () => {
    const seen = { loc: 'https://a.com/x' };
    const url = new URL('https://other.example/remembered');
    rememberParsedLoc(seen, url);
    expect(parsedLoc(seen)).toBe(url);
    rememberParsedLoc(seen, null);
    expect(parsedLoc(seen)).toBeNull();
    expect(parsedLoc({ loc: 'https://a.com/y' })?.href).toBe('https://a.com/y');
    expect(parsedLoc({ loc: 'relative' })).toBeNull();
  });
});
