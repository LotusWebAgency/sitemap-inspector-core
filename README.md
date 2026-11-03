# @lotuswebagency/sitemap-core

The sitemap engine behind [XML Sitemap Inspector](https://chromewebstore.google.com/detail/xml-sitemap-inspector/pdcmgglonolfboajejddacmijnhgbplp), a Chrome extension by [Lotus Web Agency](https://lotuswebagency.com/extensions/). It finds, fetches, parses and validates XML sitemaps and robots.txt files as streams, with bounded memory. It needs no DOM and no browser APIs, only `fetch`, web streams, `DecompressionStream` and `TextDecoderStream`, so it runs in Node, workers and browsers.

The extension is described at <https://lotuswebagency.com/extensions/xml-sitemap-inspector/>. More of our extensions are listed at <https://lotuswebagency.com/extensions/>.

## What is in this package

- Sitemap parsing: a streaming tokenizer and parser for `urlset` and `sitemapindex` documents, including gzip and the image, video, news, mobile and hreflang extensions.
- Discovery: finding a site's sitemaps from robots.txt, page hints and common paths.
- robots.txt: fetching, `Sitemap:` lines, rule groups, and a matcher for allow/disallow verdicts.
- Validation rules: the rule set listed below.

Not included: the extension's user interface, scan orchestration, storage and hosted services. The repository has tests and fixtures; the published package ships compiled code only.

## Install

```sh
npm install @lotuswebagency/sitemap-core
```

Requires Node `^22.13.0 || ^24.0.0 || >=26.0.0`, or any runtime with `fetch`, web streams, `DecompressionStream` and `TextDecoderStream`. The package is ESM only.

## Example

Fetch, parse and validate one sitemap:

```ts
import { SitemapParser, ValidationRun, fetchRobots, fetchTextStream, mediaType } from '@lotuswebagency/sitemap-core';

const sitemapUrl = 'https://example.com/sitemap.xml';
const origin = new URL(sitemapUrl).origin;
const robots = await fetchRobots(origin);
const res = await fetchTextStream(sitemapUrl);
if (!res.ok || !res.stream) throw new Error(`HTTP ${res.status}`);

const run = new ValidationRun({
  origin, sitemapUrl, robots, now: Date.now(),
  finalUrl: res.finalUrl, redirected: res.redirected, httpLastModified: res.lastModified, contentType: mediaType(res.contentType),
});
const parser = new SitemapParser({ onRecords: (records, ext) => { run.recordBatch(records, ext); } });
for await (const chunk of res.stream) {
  parser.write(chunk);
  if (parser.overLimit) break;
}
const findings = run.finish(parser.finish());
for (const f of findings) console.log(f.severity, f.ruleId, f.count, f.message);
```

`fetchTextStream` decompresses gzip and decodes UTF-8 as it reads. `SitemapParser` takes optional limits (`maxBytes`, `maxUrls`) as its third argument and stops accepting input once one is hit; `overLimit` tells the caller to stop reading.

`ValidationContext.contentType` expects the lowercased media type, so pass the raw header through `mediaType`.

Use `discoverSitemaps(origin, robots)` to find a site's sitemaps first, and `sniffSitemap(url)` to check one URL with a small ranged request. Both take a `transport` option too: `discoverSitemaps(origin, robots, undefined, { transport })`.

## Transport

Every network request goes through a `Transport`: `(url, init) => Promise<{ res, finalUrl, redirected }>`. The default, `defaultTransport`, is a plain `fetch` that sends no credentials and bypasses the HTTP cache. Pass your own through the `transport` option of `fetchTextStream`, `sniffSitemap`, `fetchRobots` and `discoverSitemaps` to route requests through a proxy or add headers. `finalUrl` and `redirected` are returned beside the `Response` because a proxied response cannot carry them.

A custom transport must keep to this contract:

- Honor `init.signal`. The timeouts work by aborting it, so a transport that ignores it can hang a fetch.
- `res` carries the upstream status and headers.
- The body is the bytes after HTTP content-coding is removed. A raw `.gz` file stays gzip and the engine unzips it; br and zstd must already be decoded.
- `finalUrl` is a non-empty absolute URL. An empty one is replaced by the requested URL.

```ts
import { type Transport, fetchRobots } from '@lotuswebagency/sitemap-core';

const viaProxy: Transport = async (url, init) => {
  const res = await fetch(`https://proxy.example/?url=${encodeURIComponent(url)}`, init);
  return { res, finalUrl: res.headers.get('x-final-url') ?? url, redirected: res.headers.has('x-final-url') };
};
const robots = await fetchRobots('https://example.com', { transport: viaProxy });
```

## Entry points

The package root exports the stable API: `SitemapParser`, `ValidationRun`, `MSG`, `discoverSitemaps`, `COMMON_PATHS`, `fetchRobots`, `parseRobots`, `parseRobotsGroups`, `compileRobots`, `matchRobots`, `robotsPathOf`, `fetchTextStream`, `sniffSitemap`, `defaultTransport`, `mediaType`, `NotUtf8Error`, and the types `Transport`, `TransportResponse`, `FetchOptions`, `TextStreamResult`, `SniffResult`, `Discovered`, `DiscoveryResult`, `DiscoveryOptions`, `ParseResult`, `ParseLimits`, `ParseCallbacks`, `IndexChild`, `ValidationContext`, `RuleId`, `CompiledRobots`, `MatchMeter`, `RobotsVerdict`, plus the shared types. Other modules are reachable as subpaths, for example `@lotuswebagency/sitemap-core/validator`, and are less stable.

`matchRobots(compiled, path, meter)` takes the path and query that `robotsPathOf(url, origin)` returns, not `URL.pathname`: rules such as `Disallow: /*?id=` match the query too. `robotsPathOf` returns `null` for a URL on another origin or a non-http(s) URL.

## Validation rules

`MSG` maps each rule id to its severity and English message. `ValidationRun` reports findings by these ids.

| Rule id | Severity | Message |
| --- | --- | --- |
| `xml-parse-error` | error | XML syntax errors |
| `invalid-root` | error | Root element is not \<urlset> or \<sitemapindex> |
| `missing-namespace` | error | Missing or wrong sitemap namespace on the root element |
| `missing-loc` | error | \<url> or \<sitemap> entries without a \<loc> |
| `invalid-loc` | error | \<loc> values that are not absolute http(s) URLs |
| `invalid-utf8` | error | URLs containing invalid UTF-8 (replacement characters) |
| `loc-too-long` | error | URLs of 2,048 characters or longer |
| `too-many-urls` | error | More than 50,000 URLs (or index entries) in one sitemap file |
| `file-too-large` | error | Uncompressed size exceeds 50 MB |
| `cross-host` | error | URLs whose scheme, host (www included) or port differs from the sitemap |
| `invalid-lastmod` | error | \<lastmod> values that are not valid W3C dates |
| `invalid-changefreq` | error | Invalid \<changefreq> values |
| `invalid-priority` | error | \<priority> values outside 0.0–1.0 |
| `invalid-child-loc` | error | Index entries with invalid \<loc> |
| `unescaped-ampersand` | error | Unescaped & characters (write them as `&amp;`) |
| `parse-truncated` | error | Parsing stopped at the hard limit of 150,000 URLs or 150 MB; results are partial |
| `image-too-many` | error | URLs with more than 1,000 images |
| `news-too-many` | error | More than 1,000 news entries in one sitemap |
| `news-missing-field` | error | Required news tags missing |
| `news-invalid-language` | error | News languages that are not ISO 639 codes |
| `news-invalid-date` | error | News publication dates that are not W3C dates |
| `video-missing-field` | error | Required video tags missing |
| `video-invalid-value` | error | Video tags with invalid values |
| `not-in-robots` | warning | Sitemap is not referenced in robots.txt |
| `protocol-www-mix` | warning | URLs mixing http/https or www/non-www with the site origin |
| `duplicate-urls` | warning | Duplicate URLs |
| `fake-freshness` | warning | Nearly all URLs share one lastmod date, so it looks bulk-set |
| `future-lastmod` | warning | Future lastmod dates |
| `stale-sitemap` | warning | Sitemap content looks stale (no update signal within a year) |
| `redirected-sitemap` | warning | Sitemap URL redirects |
| `empty-sitemap` | warning | Sitemap contains no entries |
| `tracking-params` | warning | URLs carrying utm_ tracking parameters |
| `invalid-hreflang` | warning | Invalid hreflang language codes |
| `hreflang-missing-self` | warning | URLs whose hreflang set omits the URL itself |
| `hreflang-missing` | warning | URLs without hreflang alternates, while at least half of this sitemap's URLs have them |
| `news-too-old` | warning | News articles published more than 2 days before the scan |
| `robots-blocked` | warning | URLs disallowed for Googlebot by robots.txt |
| `unexpected-content-type` | warning | Unexpected Content-Type (some crawlers reject HTML responses) |
| `priority-changefreq-ignored` | info | The priority and changefreq tags are present but ignored by Google |
| `no-xdefault` | info | Missing x-default entry in hreflang clusters |
| `image-deprecated-field` | info | Image tags Google no longer reads (caption, title, geo_location, license) |
| `mobile-obsolete` | info | \<mobile:mobile> tags, which Google ignores |
| `video-deprecated-field` | info | Video tags Google no longer reads (category, gallery_loc, price, tvshow) |
| `robots-unverified` | info | URLs not checked against robots.txt (another origin, robots.txt unreadable, or past the check limits) |
| `encoding-not-utf8` | error | XML declaration names an encoding other than UTF-8 |
| `duplicate-field` | error | Entries repeating \<loc>, \<lastmod>, \<changefreq> or \<priority> (only the first is used) |
| `wrong-entry-kind` | error | \<url> entries in a sitemap index, or \<sitemap> entries in a URL sitemap |
| `misplaced-element` | warning | Entries or text in unexpected places (entries belong directly under the root element) |
| `alternate-wrong-namespace` | warning | Alternate links outside the xhtml namespace (not read as hreflang) |
| `extension-namespace-unknown` | warning | Extension namespaces that are not the documented ones (image, video, news, mobile, xhtml) |
| `invalid-extension-url` | warning | Image or video URL tags that are missing or not absolute http(s) URLs |
| `outside-sitemap-path` | warning | URLs outside the sitemap's directory |

## License

MIT. Copyright (c) 2026 LW AGENCY LIMITED.
