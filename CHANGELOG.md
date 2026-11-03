# Changelog

## 0.1.0

First public release.

- Streaming XML sitemap tokenizer and parser for `urlset` and `sitemapindex`, with gzip support and the image, video, news, mobile and hreflang extensions.
- `ValidationRun` and the `MSG` rule table.
- Sitemap discovery from robots.txt, page hints and common paths.
- robots.txt fetching, parsing and matching.
- Pluggable `Transport` for every network request.
- Root exports include `robotsPathOf`, `NotUtf8Error` and the option, result and callback types; `./package.json` is exported.
- Documented `Transport` contract: it must honor `init.signal`, return a body with HTTP content-coding removed, and an empty `finalUrl` falls back to the requested URL.
