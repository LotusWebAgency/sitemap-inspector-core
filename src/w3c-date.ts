// https://www.w3.org/TR/NOTE-datetime — YYYY | YYYY-MM | YYYY-MM-DD | YYYY-MM-DDThh:mm[:ss[.s+]]TZD
const W3C_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?)?)?$/;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidW3CDate(s: string): boolean {
  const m = W3C_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d, hh, mm, ss, tzh, tzm] = m;
  if (mo !== undefined) {
    const month = Number(mo);
    if (month < 1 || month > 12) return false;
    if (d !== undefined) {
      const max = month === 2 && isLeap(Number(y)) ? 29 : (DAYS[month - 1] ?? 31);
      if (Number(d) < 1 || Number(d) > max) return false;
    }
  }
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return false;
  if (ss !== undefined && Number(ss) > 59) return false;
  if (tzh !== undefined && (Number(tzh) > 23 || Number(tzm) > 59)) return false;
  return true;
}

const MAX_PARSED_CACHE = 1000;
const parsed = new Map<string, number>();

/**
 * The time of a valid W3C date in ms since the epoch, NaN for anything else. Memoized: the parser and the validator both
 * read every <lastmod>, and a sitemap repeats a few values many times. A flood of distinct values only clears the memo.
 */
export function parseW3CDate(s: string): number {
  const known = parsed.get(s);
  if (known !== undefined) return known;
  const t = isValidW3CDate(s) ? Date.parse(s) : NaN;
  if (parsed.size >= MAX_PARSED_CACHE) parsed.clear();
  parsed.set(s, t);
  return t;
}

/** A valid W3C date that names a day: YYYY-MM-DD at least. News and video dates need that much; a bare year or month fails. */
export const isFullW3CDate = (s: string): boolean => s.length >= 10 && isValidW3CDate(s);
