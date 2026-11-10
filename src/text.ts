/**
 * The first n UTF-16 code units of s, one fewer when the result would end on a high surrogate, so a pair is never split.
 * That includes a string exactly n long, so text accumulated chunk by chunk caps the same as the whole text cut once.
 * Internal: not a package export.
 */
export function cut(s: string, n: number): string {
  if (s.length < n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
