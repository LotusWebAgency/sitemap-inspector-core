// A host with `*` parses (`new URL('https://*.bank.com/').origin` is `https://*.bank.com`) and a caller that turns the
// origin into a host-permission pattern would request a wildcard host, so it is not a URL here.
export function isHttpUrl(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    return (protocol === 'http:' || protocol === 'https:') && hostname !== '' && !hostname.includes('*');
  } catch {
    return false;
  }
}

// Bounds for the hints a caller can pass to discovery: a page URL and the page's <link rel="sitemap"> hrefs.
export const MAX_HINT_URL_CHARS = 2048;
export const MAX_PAGE_LINKS = 20;

// A hint URL as it is kept and fetched: no fragment, and no userinfo (a `user:pass@` in a page URL or link
// would otherwise be retained in results, and fetch() rejects such URLs anyway).
export function cleanHintUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return u;
  }
}

// The page URL is fetched only when it looks like a sitemap: a GET of an arbitrary page URL could consume a
// single-use link (magic login, password reset). The path is read up to the first `;` (path parameters), and the
// query counts only as the sole parameter, so a token URL can't qualify by carrying `next=sitemap.xml` along.
export function looksLikeSitemapUrl(u: string): boolean {
  try {
    const { pathname, searchParams } = new URL(u);
    const path = (pathname.split(';')[0] ?? '').toLowerCase();
    if (path.endsWith('.xml') || path.endsWith('.xml.gz') || path.includes('sitemap')) return true;
    const params = [...searchParams];
    const [key = '', value = ''] = params.length === 1 ? params[0] ?? [] : [];
    return params.length === 1 && (key.toLowerCase().startsWith('sitemap') || /^sitemap[\w.-]*$/i.test(value));
  } catch {
    return false;
  }
}

// A sitemap URL in normalized form (index child, robots.txt line, user-supplied): http(s) only, no fragment and no
// userinfo, null otherwise.
export function normalizeSitemapUrl(u: string): string | null {
  if (!isHttpUrl(u)) return null;
  try {
    const url = new URL(u);
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** The URL on the site origin (same path, query and fragment) when u sits on one of the given alias origins, else u itself. */
export function aliasSiteUrl(u: URL, scanOrigin: string, aliases: readonly string[] | undefined): URL {
  if (aliases === undefined || aliases.length === 0 || u.origin === scanOrigin || !aliases.includes(u.origin)) return u;
  try { return new URL(scanOrigin + u.href.slice(u.origin.length)); } catch { return u; }
}

