/** normalizeUrl for an already parsed URL. */
export function normalizeParsed(url: URL): string | null {
  if (!/^https?:$/.test(url.protocol)) return null;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

// Folds case of scheme and host, the default port, the fragment and one trailing slash: "is this the same page?"
// (current-page match, robots.txt listing, hreflang self-reference). Duplicate detection uses duplicateKey instead.
export function normalizeUrl(u: string): string | null {
  let url: URL;
  try { url = new URL(u); } catch { return null; }
  return normalizeParsed(url);
}

/**
 * What makes two <loc> values the same URL for the duplicate check: the URL as the parser resolves it (scheme and host
 * lowercased, default port dropped, dot segments resolved, unescaped characters percent-encoded; the hex case of an existing
 * escape stays as written), nothing more. `/a`, `/a/` and `/a#x` are three URLs, and so are `/%2f` and `/%2F`.
 */
export function duplicateKey(url: URL): string | null {
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

// The parser parses every <loc> once; the validator takes the result from here instead of parsing it again.
// Keyed by record, so nothing is stored with the record itself (records go to IndexedDB).
const parsedLocs = new WeakMap<object, URL | null>();

export function rememberParsedLoc(record: object, url: URL | null): void {
  parsedLocs.set(record, url);
}

/** The parsed <loc> of a record, parsing it here when the parser did not (records built by hand or read back from storage). */
export function parsedLoc(record: { loc: string }): URL | null {
  const known = parsedLocs.get(record);
  if (known !== undefined) return known;
  try { return new URL(record.loc); } catch { return null; }
}
