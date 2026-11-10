import { describe, expect, it } from 'vitest';
import { hash53 } from './hash53.js';

describe('hash53', () => {
  it('is a stable 53-bit safe integer', () => {
    const h = hash53('https://a.com/x');
    expect(Number.isSafeInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(hash53('https://a.com/x')).toBe(h);
    expect(hash53('')).toBe(3338908027751811);
    expect(hash53('a')).toBe(7929297801672961);
    expect(hash53('hello')).toBe(4625896200565286);
  });
  it('tells apart URLs that differ in one character, case or a trailing slash', () => {
    const urls = ['https://a.com/x', 'https://a.com/y', 'https://a.com/X', 'https://a.com/x/', 'http://a.com/x'];
    expect(new Set(urls.map(hash53)).size).toBe(urls.length);
  });
  it('has no collision over 200,000 similar URLs', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200_000; i++) seen.add(hash53(`https://www.example.com/catalog/product-${i}?ref=${i % 97}`));
    expect(seen.size).toBe(200_000);
  });
});
