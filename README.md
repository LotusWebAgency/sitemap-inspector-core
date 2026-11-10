# @lotuswebagency/sitemap-inspector-core

The sitemap engine behind [XML Sitemap Inspector](https://chromewebstore.google.com/detail/xml-sitemap-inspector/pdcmgglonolfboajejddacmijnhgbplp), a Chrome extension by [Lotus Web Agency](https://lotuswebagency.com/extensions/). It finds, fetches, parses and validates XML sitemaps and robots.txt files as streams, with bounded memory. It needs no DOM and no browser APIs, only `fetch`, web streams, `DecompressionStream` and `TextDecoderStream`, so it runs in Node, workers and browsers.

The extension is described at <https://lotuswebagency.com/extensions/xml-sitemap-inspector/>. More of our extensions are listed at <https://lotuswebagency.com/extensions/>.

## What is in this package

- Sitemap parsing: a streaming tokenizer and parser for `urlset` and `sitemapindex` documents, including gzip and the image, video, news, mobile and hreflang extensions. A plain-text sitemap (one URL per line, the sitemaps.org "Text" format) is read as a `urlset`; `ParseResult.text` is set for it.
- Discovery: finding a site's sitemaps from robots.txt, page hints and common paths.
- robots.txt: fetching, `Sitemap:` lines, rule groups, and a matcher for allow/disallow verdicts.
- Validation rules: the rule set listed below.

Not included: the extension's user interface, scan orchestration, storage and hosted services. The repository has tests and fixtures; the published package ships compiled code only.

## Install

```sh
npm install @lotuswebagency/sitemap-inspector-core
```

Requires Node `^22.13.0 || ^24.0.0 || >=26.0.0`, or any runtime with `fetch`, web streams, `DecompressionStream` and `TextDecoderStream`. The package is ESM only.

## Example

Fetch, parse and validate one sitemap:

```ts
import { SitemapParser, ValidationRun, fetchRobots, fetchTextStream, mediaType } from '@lotuswebagency/sitemap-inspector-core';

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

`ValidationContext.contentType` expects the lowercased media type, so pass the raw header through `mediaType`. `ValidationContext.origin` may be any form of the site origin (`https://Example.com`, with a trailing slash or a path); the run canonicalizes it. `ValidationRun.finish()` is idempotent: a second call returns the same array and ignores its argument.

Use `discoverSitemaps(origin, robots)` to find a site's sitemaps first, and `sniffSitemap(url)` to check one URL with a small ranged request. Both take a `transport` option too: `discoverSitemaps(origin, robots, undefined, { transport })`.

## Transport

Every network request goes through a `Transport`: `(url, init) => Promise<{ res, finalUrl, redirected }>`. The default, `defaultTransport`, is a plain `fetch` that sends no credentials and bypasses the HTTP cache. Pass your own through the `transport` option of `fetchTextStream`, `sniffSitemap`, `fetchRobots` and `discoverSitemaps` to route requests through a proxy or add headers. `finalUrl` and `redirected` are returned beside the `Response` because a proxied response cannot carry them.

A custom transport must keep to this contract:

- Honor `init.signal`. The timeouts work by aborting it, so a transport that ignores it can hang a fetch.
- `res` carries the upstream status and headers.
- The body is the bytes after HTTP content-coding is removed. A raw `.gz` file stays gzip and the engine unzips it; br and zstd must already be decoded.
- `finalUrl` is an absolute http(s) URL. Anything else (empty, relative, another scheme) is replaced by the requested URL.

```ts
import { type Transport, fetchRobots } from '@lotuswebagency/sitemap-inspector-core';

const viaProxy: Transport = async (url, init) => {
  const res = await fetch(`https://proxy.example/?url=${encodeURIComponent(url)}`, init);
  return { res, finalUrl: res.headers.get('x-final-url') ?? url, redirected: res.headers.has('x-final-url') };
};
const robots = await fetchRobots('https://example.com', { transport: viaProxy });
```

## Limits

Every cap the engine applies. Sizes are counted after decompression; "characters" are UTF-16 code units of the decoded text. A cap that keeps the first N characters keeps at most N and never splits a surrogate pair: when the Nth character is the first half of a pair, the cut falls one unit earlier. Wrapping a printer row (below) is not a cap, keeps every character and cuts at exactly 8,192 units.

| Limit | Value | Behavior past it |
| --- | --- | --- |
| `maxBytes` (`ParseLimits`) | 157,286,400 bytes (150 MiB) of decoded UTF-8 | `overLimit` turns true after the chunk that crossed it; the rest is ignored and `truncated` is set |
| `maxUrls` (`ParseLimits`) | 150,000 URLs, or index entries | Same as `maxBytes` |
| Sitemap protocol: URLs | 50,000 per file | Reported as `too-many-urls`; parsing continues up to `maxUrls` |
| Sitemap protocol: size | 50 MB (52,428,800 bytes) uncompressed | Reported as `file-too-large`; parsing continues up to `maxBytes` |
| Hard stop reached | 150,000 URLs or 150 MB | Reported as `parse-truncated`; results are partial |
| URL length | 2,048 characters | The validator reports a `<loc>` of 2,048 characters or more as `loc-too-long`. A robots.txt `Sitemap:` line longer than 2,048 characters is ignored, and a redirect target longer than 2,048 is not kept |
| Element nesting | 64 levels | Deeper elements are counted but not tracked |
| Tag, comment, processing instruction, declaration, DOCTYPE | 65,536 characters each | Reported as an error, discarded without buffering, parsing resumes after it |
| CDATA section | 1,048,576 characters, `<![CDATA[` included | Same |
| Accumulated text run | 65,536 characters | The first 65,536 are kept |
| Text of one field (`<loc>`, `<lastmod>`, ...) | 8,192 characters | The first 8,192 are kept |
| Plain-text sitemap line | 4,096 characters | The first 4,096 are kept (a URL that long fails the 2,048-character check anyway) |
| Extension field value (image, video, news) | 2,048 characters | The first 2,048 are kept |
| Video `<video:description>` / `<video:uploader>` | 2,048 / 255 characters, measured trimmed over the whole value | Reported as `video-invalid-value` |
| Extension findings per URL | 20 | The rest are dropped |
| Distinct `<lastmod>` values counted | 1,000 | Values already seen keep counting; new ones are not tracked (affects `fake-freshness` only) |
| Index children kept | 4,000 entries, each `<loc>` cut to 2,049 characters | The rest are counted in `childOverflow`, not kept |
| Hreflang alternates per URL | 500 | The rest are dropped |
| Distinct hreflang languages | 1,000 | |
| Declared namespace prefixes | 100 | |
| Structural issues kept per code | 20 | The rest are dropped |
| Finding example value, string param | 300 characters | Cut, with an ellipsis |
| XML declaration `encoding` name | 64 characters | Cut |
| `Last-Modified` header | 64 characters | A longer header is dropped |
| `Content-Type` media type | 100 characters, one `type/subtype` token | Anything else is dropped by `mediaType` |
| robots.txt body | 524,288 characters | Cut at the last complete line |
| robots.txt groups / rules / `Sitemap:` lines | 500 / 5,000 / 500 | The rest are ignored |
| robots.txt rule path | 2,048 characters | The rule is ignored |
| robots.txt matching | paths up to 8,192 characters; 300,000,000 steps per `MatchMeter`; 50,000 `*`-separated pattern parts per compiled rule set | The verdict is `over-limit` |
| Page links used by discovery | 20 | The first 20 valid http(s) links count; the rest are ignored |
| Printer output row | 8,192 characters per piece | A longer line continues in the next row, and a row of exactly 8,192 characters continues too (`continuesRow` from the `printer` subpath) |
| Printer row indent | Stops growing at depth 32 | Deeper rows keep the depth-32 indent |
| Plain-text sniff | 65,536 leading whitespace characters | A body with more is never read as a plain-text sitemap |
| Timeouts | 30 s idle and 120 s total for a sitemap; 15 s idle and 30 s total for robots.txt and the sniff probe; the gzip trailer probe has one 15 s timer for its whole request | The request is aborted; override with `timeoutMs` and `totalMs`. The trailer probe takes only `timeoutMs` |

`onLines` receives the printed rows in batches of at most 1,000.

The package never follows a sitemap index into its children. Walking an index, and how deep to go, is up to the caller.

Once a hard limit (`maxBytes`, `maxUrls`) is hit, `finish()` reports `parse-truncated` and no XML error for the construct the stop cut; the structure checks that need the whole document (unclosed elements, missing root) are skipped too.

## Security model

- All input is untrusted. Sitemaps, robots.txt and the responses to every probe are treated as hostile, and the parser keeps its own state bounded by the caps above whatever the document contains.
- No DTD processing and no entity expansion beyond the five predefined entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) and numeric character references. A `<!DOCTYPE>`, including its internal subset, is streamed past without being interpreted; external and internal entities are never defined, resolved or fetched, so there is no billion-laughs or XXE path.
- Parsing is streaming. Memory depends on the caps, not on the file size: the tokenizer holds at most one unfinished construct (up to 1 MiB for CDATA), and records are handed to `onRecords` in batches.
- gzip is decoded as a stream (`DecompressionStream`), only as fast as the consumer reads. The decoded size is counted against `maxBytes`, so a decompression bomb ends at the hard limit once the caller stops reading on `overLimit`. A caller that ignores `overLimit` and keeps reading carries on decoding.
- The transport is supplied by the caller (`fetch` by default), so the engine has no network policy of its own. It does not block private, loopback or link-local addresses. If URLs come from untrusted sources, or the code runs on a server, SSRF protection (address filtering, DNS pinning, egress rules) belongs in your `Transport`.
- Redirects: the default transport lets `fetch` follow them (`redirect: 'follow'`) with `credentials: 'omit'`, so no cookies or HTTP auth go along. The engine does not limit or inspect redirect hops beyond what the runtime does. It reports `finalUrl` and `redirected` so the caller can check where a response came from, and the validator raises `redirected-sitemap`. A size probe that was redirected to another origin gets no follow-up request of its own. A transport that enforces redirect policy (for example re-checking every hop against an allowlist) must do it itself.
- Discovery makes `GET` requests (six at a time) to the common sitemap paths on the origin you pass, to the tab URL only when it is same-origin and `looksLikeSitemapUrl`, to the first 20 valid http(s) page links you hand in (a link with a wildcard host or another scheme is skipped and takes no slot), and to every `Sitemap:` URL in robots.txt. Those robots.txt URLs are chosen by the remote site and may point to another host, so a server-side caller must filter them in its transport.

## Entry points

The package root exports the stable API: `SitemapParser`, `ValidationRun`, `MSG`, `discoverSitemaps`, `COMMON_PATHS`, `fetchRobots`, `parseRobots`, `parseRobotsGroups`, `compileRobots`, `matchRobots`, `robotsPathOf`, `fetchTextStream`, `sniffSitemap`, `defaultTransport`, `mediaType`, `NotUtf8Error`, and the types `Transport`, `TransportResponse`, `FetchOptions`, `FetchMeta`, `TextStreamResult`, `SizeHeaders`, `SniffResult`, `SniffKind`, `Discovered`, `DiscoveryResult`, `DiscoveryOptions`, `DiscoveryDeps`, `CandidateSource`, `FailedRobotsReason`, `ParseResult`, `ParseLimits`, `ParseCallbacks`, `IndexChild`, `StructuralIssue`, `ExtensionHit`, `ValidationContext`, `RuleId`, `CompiledRobots`, `MatchMeter`, `RobotsVerdict`, plus the shared types. Other modules are reachable as subpaths, for example `@lotuswebagency/sitemap-inspector-core/validator`, and are less stable: they can change in a minor release.

`parseRobots` ends a `Sitemap:` value at whitespace followed by `#`, so a `#` glued into the URL stays in it as a fragment. `parseRobotsGroups` cuts every line at its first `#`.

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
