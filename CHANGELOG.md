# Changelog

## 0.1.0 — unreleased

First public release.

- Streaming XML sitemap tokenizer and parser for `urlset` and `sitemapindex`, with gzip support and the image, video, news, mobile and hreflang extensions.
- `ValidationRun` and the `MSG` rule table.
- Sitemap discovery from robots.txt, page hints and common paths.
- robots.txt fetching, parsing and matching.
- Pluggable `Transport` for every network request.
- Root exports include `robotsPathOf`, `NotUtf8Error` and the option, result and callback types; `./package.json` is exported.
- Documented `Transport` contract: it must honor `init.signal`, return a body with HTTP content-coding removed, and a `finalUrl` that is not an absolute http(s) URL falls back to the requested URL.
- Plain-text sitemaps (one URL per line) are parsed as a `urlset`; `ParseResult.text` says so.
- A parse stopped by a hard limit reports only `parse-truncated`, not the construct the stop cut as an XML syntax error.
- `fetchTextStream` drops a `Last-Modified` header longer than 64 characters.
- Subpath exports are listed explicitly in `package.json`; a new module is not public until it is added there.
- `aliasSiteUrl` maps an alias URL with userinfo onto the scan origin (dropping the userinfo) instead of producing a malformed URL.
- `Discovered.longFinalOrigin` is not set for a wildcard (`*`) host.
- `pLimit` throws a `RangeError` for `n <= 0` or `NaN`; a synchronous throw from a task rejects its promise and frees the slot.
- `mediaType` rejects non-ASCII characters that lowercase into ASCII (for example U+212A, the Kelvin sign).
- The gzip trailer size is used only when the 206 `Content-Range` is exactly the last four bytes; otherwise the compressed size is reported with `sizeCompressed`.
- An empty chunk between a CR and a LF no longer breaks CRLF pairing (parser text mode and printer).
- Video description and uploader lengths are measured trimmed at any size, so indented XML no longer gets a false `video-invalid-value`.
- `stale-sitemap` reads a `Last-Modified` only in one of the three HTTP date forms (RFC 9110).
- `not-in-robots` is reported when the sitemap URL or a robots.txt `Sitemap:` URL cannot be normalized (before, two unparsable URLs counted as a match).
- `User-agent: *foo` is not the wildcard group (RFC 9309), and the product token folds ASCII only.
- A non-canonical `ValidationContext.origin` no longer makes every URL `robots-other-origin`.
- On a specificity tie the reported robots rule is the earliest line; the verdict is unchanged.
- `ValidationRun.finish()` returns the same result when called again.
- Caps never split a surrogate pair: a cut that would end on the first half of a pair keeps one unit fewer, so a capped string is always well-formed.
- The root also exports the types `StructuralIssue`, `ExtensionHit`, `DiscoveryDeps`, `CandidateSource`, `FailedRobotsReason`, `FetchMeta`, `SizeHeaders` and `SniffKind`.
- The release workflow runs only on a version tag.
