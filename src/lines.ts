const LF = 10;

/**
 * Splits a chunk at line breaks (\n, \r\n or a lone \r), one piece per call to next(). The positions of the next \n and \r
 * are cached, so a chunk with many breaks costs one indexOf per break of each kind, not one per line. A CR that ends a chunk
 * is remembered in `pendingCr`, so a LF that opens the next chunk is part of that break; an empty chunk changes nothing.
 * Internal: not a package export.
 */
export class LineScanner {
  /** The current piece is s[from, end), which holds no break (empty between two breaks). */
  from = 0;
  end = 0;
  /** The piece ended at a break; false for the last piece of the chunk. */
  broke = false;
  /** The last chunk ended on a CR: a LF that opens the next chunk belongs to that break. Clear it where a new row starts. */
  pendingCr = false;
  private s = '';
  private n = 0;
  private pos = 0;
  private nl = -2;
  private cr = -2;

  begin(s: string): void {
    this.s = s;
    this.n = s.length;
    this.pos = 0;
    this.nl = -2;
    this.cr = -2;
    if (this.n === 0 || !this.pendingCr) return;
    this.pendingCr = false;
    if (s.charCodeAt(0) === LF) this.pos = 1;
  }

  next(): boolean {
    const { s, n } = this;
    const from = this.pos;
    if (from >= n) { this.s = ''; return false; } // drop the chunk so an idle scanner keeps nothing alive
    let nl = this.nl;
    let cr = this.cr;
    if (nl !== -1 && nl < from) nl = this.nl = s.indexOf('\n', from);
    if (cr !== -1 && cr < from) cr = this.cr = s.indexOf('\r', from);
    const br = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    this.from = from;
    this.broke = br !== -1;
    if (br === -1) { this.end = n; this.pos = n; return true; }
    this.end = br;
    let next = br + 1;
    if (br === cr) {
      if (next === n) this.pendingCr = true;
      else if (s.charCodeAt(next) === LF) next++;
    }
    this.pos = next;
    return true;
  }
}
