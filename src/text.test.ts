import { describe, expect, it } from 'vitest';
import { cut } from './text.js';

describe('cut', () => {
  it('returns the first n code units of a string without surrogates', () => {
    expect(cut('abcdef', 3)).toBe('abc');
    expect(cut('abcdef', 5)).toBe('abcde');
    expect(cut('', 3)).toBe('');
  });

  it('returns the string whole when n is at least its length', () => {
    expect(cut('abc', 3)).toBe('abc');
    expect(cut('abc', 10)).toBe('abc');
    expect(cut('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
  });

  it('backs off one unit when the cut would end on a high surrogate', () => {
    const s = 'ab\u{1F600}cd'; // the pair sits at indexes 2 and 3
    expect(cut(s, 3)).toBe('ab');
    expect(cut(s, 3).isWellFormed()).toBe(true);
  });

  it('keeps a pair that ends exactly at n, and cuts right before one', () => {
    const s = 'ab\u{1F600}cd';
    expect(cut(s, 4)).toBe('ab\u{1F600}');
    expect(cut(s, 2)).toBe('ab');
  });

  it('cuts at most n code units and stays well-formed at every n', () => {
    const s = 'a\u{1F600}b\u{1F680}c';
    for (let n = 0; n <= s.length + 1; n++) {
      const out = cut(s, n);
      expect(out.length).toBeLessThanOrEqual(n);
      expect(out.isWellFormed()).toBe(true);
    }
  });
});

describe('cut at the cap', () => {
  it('drops a trailing high surrogate when the string is exactly n long', () => {
    expect(cut('ab\ud83d', 3)).toBe('ab');
    expect(cut('ab\ud83d', 4)).toBe('ab\ud83d');
  });
});
