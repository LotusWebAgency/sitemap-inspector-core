import { describe, expect, it } from 'vitest';
import { LineScanner } from './lines.js';

function scan(sc: LineScanner, s: string): string[] {
  const pieces: string[] = [];
  sc.begin(s);
  while (sc.next()) pieces.push(s.slice(sc.from, sc.end) + (sc.broke ? '|' : ''));
  return pieces;
}

describe('LineScanner', () => {
  it('splits at LF, CRLF and lone CR, with no piece after a final break', () => {
    expect(scan(new LineScanner(), 'a\nb\r\nc\rd')).toEqual(['a|', 'b|', 'c|', 'd']);
    expect(scan(new LineScanner(), 'a\n\n\r\nb\n')).toEqual(['a|', '|', '|', 'b|']);
    expect(scan(new LineScanner(), '')).toEqual([]);
  });

  it('pairs a CR that ends a chunk with a LF that opens the next one', () => {
    const sc = new LineScanner();
    expect(scan(sc, 'a\r')).toEqual(['a|']);
    expect(sc.pendingCr).toBe(true);
    expect(scan(sc, '\nb')).toEqual(['b']);
    expect(sc.pendingCr).toBe(false);
  });

  it('counts a LF after a LF, or one that is not first in the chunk, as its own break', () => {
    const sc = new LineScanner();
    scan(sc, 'a\r');
    expect(scan(sc, 'x\ny')).toEqual(['x|', 'y']);
    expect(scan(new LineScanner(), 'a\n')).toEqual(['a|']);
  });

  it('ignores an empty chunk between a CR and its LF', () => {
    const sc = new LineScanner();
    scan(sc, 'a\r');
    expect(scan(sc, '')).toEqual([]);
    expect(sc.pendingCr).toBe(true);
    expect(scan(sc, '\nb')).toEqual(['b']);
  });

  it('drops a chunk that is only the LF of a pair', () => {
    const sc = new LineScanner();
    scan(sc, 'a\r');
    expect(scan(sc, '\n')).toEqual([]);
    expect(sc.pendingCr).toBe(false);
  });
});
