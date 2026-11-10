# Contributing

Thanks for helping with `@lotuswebagency/sitemap-inspector-core`.

## Setup

Node 22, 24 or 26. Then:

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build && npm run check:pack
```

That is the gate CI runs on every push and pull request; keep it green.

## Changes

- Input is hostile. Every accumulator that grows with input has a cap, every regex applied to input is linear, and tokenizer work stays linear however the input is chunked. A new cap goes into the README "Limits" table and gets a test.
- No DOM and no browser-only APIs: `fetch`, web streams, `DecompressionStream`, `TextDecoderStream` and `Intl` only. Every network request goes through the injected `Transport`.
- Tests live beside the code (`src/*.test.ts`, Vitest). Write the failing test first, then the fix.
- Output is part of the contract: records, rows, rule ids and row flags are stored by consumers. A change to any of them is a breaking change and needs a CHANGELOG entry.
- US English in code, docs and messages. Commit messages are short and lowercase.

Open a pull request against `develop`. Describe what changed and why, and point at the test that covers it.

## Security

Do not open an issue for a vulnerability. See [SECURITY.md](SECURITY.md).
