import { mediaType, sniffSitemap, type SniffKind, type SniffResult } from './fetcher.js';
import { cleanHintUrl, isHttpUrl, looksLikeSitemapUrl, MAX_PAGE_LINKS } from './url.js';
import { MAX_HTTP_LAST_MODIFIED_CHARS, MAX_URL_CHARS } from './sitemap-limits.js';
import type { RobotsInfo } from './types.js';

// Most common first (spec §4.1): WordPress/Yoast/Rank Math, SEOPress, Astro/Gatsby/next-sitemap, Magento,
// BigCommerce, PrestaShop, Zendesk, TYPO3 (page type), news/video/image names, Blogger.
export const COMMON_PATHS = [
  '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
  '/sitemaps.xml', '/wp-sitemap.xml', '/sitemap-0.xml',
  '/sitemap.xml.gz', '/sitemap_index.xml.gz', '/sitemapindex.xml',
  '/sitemap/sitemap.xml', '/sitemap/index.xml', '/pub/sitemap.xml',
  '/pub/sitemaps/sitemap.xml', '/sitemaps/sitemap.xml', '/xmlsitemap.php',
  '/1_index_sitemap.xml', '/hc/sitemap.xml', '/?type=1533906435',
  '/news-sitemap.xml', '/sitemap-news.xml', '/sitemap_news.xml',
  '/video-sitemap.xml', '/image-sitemap.xml', '/sitemap-pages.xml',
] as const;

export function pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => { active--; queue.shift()?.(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(resolve, reject).finally(next); };
    if (active < n) run(); else queue.push(run);
  });
}

function httpOriginOf(u: string | undefined): string | undefined {
  try { const p = new URL(u ?? ''); return p.protocol === 'http:' || p.protocol === 'https:' ? p.origin : undefined; } catch { return undefined; }
}

type CandidateSource = 'tab' | 'robots' | 'page' | 'probe';
export interface Discovered {
  url: string; finalUrl: string; source: CandidateSource;
  kind: 'urlset' | 'sitemapindex'; gzip: boolean;
  longFinalOrigin?: string; // origin of a redirect target over MAX_URL_CHARS, which finalUrl does not keep
  httpStatus: number; redirected: boolean; httpLastModified?: string | undefined;
  contentType?: string | undefined;
  size?: number | null; sizeCompressed?: true; // from the sniff's ranged request, see SniffResult
}
export type FailedRobotsReason = Exclude<SniffKind, 'urlset' | 'sitemapindex'> | 'time-limit';
export interface DiscoveryResult { found: Discovered[]; failedRobots: { url: string; reason: FailedRobotsReason; status?: number | undefined; encoding?: string | undefined }[] }
export interface DiscoveryDeps { sniff: typeof sniffSitemap }
// tabUrl and pageLinks come from the page in the tab (validated in background.ts); both are optional.
export interface DiscoveryOptions {
  deadline?: number; now?: () => number;
  /** Aborted when the scan is superseded: no further sniff starts and the ones in flight are cancelled. */
  signal?: AbortSignal | undefined;
  tabUrl?: string | undefined; pageLinks?: readonly string[] | undefined;
}

export async function discoverSitemaps(origin: string, robots: RobotsInfo | null, deps: DiscoveryDeps = { sniff: sniffSitemap }, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const { deadline = Infinity, now = Date.now, tabUrl, pageLinks = [], signal } = opts;
  const robotsUrls = robots?.sitemapUrls ?? [];
  const robotsListed = new Set(robotsUrls);
  // One sniff per URL, first source wins: the tab, robots.txt, the page's links, then the common paths.
  const candidates: { url: string; source: CandidateSource }[] = [];
  const queued = new Set<string>();
  const add = (url: string, source: CandidateSource): void => {
    if (queued.has(url)) return;
    queued.add(url);
    candidates.push({ url, source });
  };
  if (tabUrl && isHttpUrl(tabUrl) && new URL(tabUrl).origin === origin && looksLikeSitemapUrl(tabUrl)) add(cleanHintUrl(tabUrl), 'tab');
  for (const url of robotsUrls) add(url, 'robots');
  for (const link of pageLinks.filter(isHttpUrl).slice(0, MAX_PAGE_LINKS)) add(cleanHintUrl(link), 'page');
  for (const p of COMMON_PATHS) add(origin + p, 'probe');
  const limit = pLimit(6);
  const sniffed = await Promise.all(candidates.map((c) => limit(async (): Promise<{ c: typeof c; r: SniffResult | null }> => {
    if (now() > deadline || signal?.aborted === true) return { c, r: null };
    try { return { c, r: await (signal ? deps.sniff(c.url, { signal }) : deps.sniff(c.url)) }; } catch { return { c, r: { sniff: 'network-error' } }; }
  })));
  const found: Discovered[] = [];
  const failedRobots: DiscoveryResult['failedRobots'] = [];
  const seenFinal = new Set<string>();
  for (const { c, r } of sniffed) {
    if (r && (r.sniff === 'urlset' || r.sniff === 'sitemapindex')) {
      const tooLong = r.finalUrl !== undefined && r.finalUrl.length > MAX_URL_CHARS; // a longer redirect target is not kept, only its origin
      const finalUrl = r.finalUrl !== undefined && !tooLong ? r.finalUrl : c.url;
      const longFinalOrigin = tooLong ? httpOriginOf(r.finalUrl) : undefined;
      if (seenFinal.has(finalUrl)) continue;
      seenFinal.add(finalUrl);
      found.push({
        url: c.url, finalUrl, ...(longFinalOrigin === undefined ? {} : { longFinalOrigin }), source: c.source, kind: r.sniff,
        gzip: r.gzip ?? false, httpStatus: r.status ?? 200,
        redirected: r.redirected ?? false, httpLastModified: r.lastModified !== undefined && r.lastModified.length <= MAX_HTTP_LAST_MODIFIED_CHARS ? r.lastModified : undefined,
        contentType: mediaType(r.contentType),
        ...(r.size === undefined ? {} : { size: r.size }), ...(r.sizeCompressed ? { sizeCompressed: true as const } : {}),
      });
    } else if (robotsListed.has(c.url)) {
      failedRobots.push(r ? { url: c.url, reason: r.sniff as FailedRobotsReason, status: r.status, encoding: r.encoding } : { url: c.url, reason: 'time-limit' });
    }
  }
  return { found, failedRobots };
}
