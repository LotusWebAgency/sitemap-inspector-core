# sitemap-inspector-core

Streaming XML sitemap and robots.txt engine (`@lotuswebagency/sitemap-inspector-core`, MIT, ESM only). It powers the XML Sitemap Inspector Chrome extension and its online version. Public package: everything here may be read by anyone, so no private paths, hosts, keys or internal project names in code, comments, docs or commit messages.

## Commands

- `npm ci` then the gate: `npm run typecheck && npm run lint && npm test && npm run build && npm run check:pack`. CI (`.github/workflows/ci.yml`) runs the same on Node 22, 24 and 26.
- `npm run build` writes `dist/` (`scripts/clean.mjs` first). Consumers that link the package locally read `dist/`, so rebuild after every change.
- `npm run check:pack` packs the tarball and asserts it holds only `dist/**`, `LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`, that every `exports` entry has its types file in the tarball, that a plain Node ESM consumer can import the root and every subpath export, and that no private reference (hosts, paths, extension APIs) appears in the packed files.

## Layout

`src/` is flat, one module per concern, tests beside the code (`*.test.ts`, Vitest); fixtures in `test/fixtures/`.

- `tokenizer.ts` → `printer.ts` (formatted rows) / `parser.ts` (records and stats) → `validator.ts` (rule engine, `MSG` table), `extensions.ts` (image, video, news, mobile by namespace URI, never by prefix).
- `discovery.ts` (robots.txt, page hints, `COMMON_PATHS`), `fetcher.ts` (`fetchTextStream`, `sniffSitemap`, gzip detection, idle and total timeouts), `transport.test.ts` (the `Transport` contract), `robots.ts` (groups, KMP matcher with a step meter; the matcher uses no regex).
- Internal, not package exports: `lines.ts` (the line scanner the parser and the printer share) and `text.ts` (`cut`, the surrogate-safe length cap: use it for every cap on a string).
- Helpers: `normalize.ts`, `url.ts`, `lang-codes.ts` (ICU through `Intl.DisplayNames`, never code tables), `w3c-date.ts`, `hash53.ts`, `row-flags.ts`, `sitemap-limits.ts`, `types.ts`.
- `index.ts` is the stable root API (listed in README "Entry points"); other modules are subpaths and less stable.

## Rules

- No DOM and no browser-only APIs: only `fetch`, web streams, `DecompressionStream`, `TextDecoderStream`, `Intl`. ESLint enforces no `DOMParser`, no page globals and no Node-only globals (`process`, `Buffer`, `require`, `__dirname`, `__filename`, `global`) in `src/`.
- Every network request goes through the injected `Transport`; it must honor `init.signal` and return a decoded body.
- Input is hostile. Every accumulator that grows with input has a cap (README "Limits"); every regex applied to input is linear; tokenizer work stays linear however the input is chunked. A new cap or limit goes into the README table and gets a test.
- `row-flags.ts` bit table is stored data in consumers: append-only, at most 31 entries.
- Output is part of the contract: consumers store records, rows and findings. A change to row numbering, record shape or rule ids is a breaking change (CHANGELOG, semver).
- US English in code, docs and messages. Commit messages short and lowercase.

## Release

`CHANGELOG.md` holds the history. Version bump, changelog entry, gate, then push a `v<version>` tag: `.github/workflows/release.yml` runs the gate again and `npm stage publish --provenance` through npm trusted publishing (the package on npmjs.com names this repository and workflow as its trusted publisher, with stage-only permission; no token is stored). A maintainer then approves the staged version with 2FA (`npm stage approve <id>` or npmjs.com). The job checks that the tag matches `package.json`. Never publish by hand: `publishConfig.provenance` needs the CI OIDC token.

Dependencies and actions are updated by Dependabot (`.github/dependabot.yml`); actions are pinned to commit SHAs with the version in a comment.
