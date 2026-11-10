// The sitemap protocol's per-file limits: the validator reports a file past either of them.
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_BYTES = 52_428_800; // 50 MiB, uncompressed UTF-8
// A URL longer than this is not followed as a sitemap location (the protocol allows fewer than 2,048 characters); the validator flags a <loc> from this length.
export const MAX_URL_CHARS = 2048;
// Last-Modified header values are kept only up to this length (a real HTTP date is 29 characters).
export const MAX_HTTP_LAST_MODIFIED_CHARS = 64;
