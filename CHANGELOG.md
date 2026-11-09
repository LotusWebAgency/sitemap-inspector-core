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
