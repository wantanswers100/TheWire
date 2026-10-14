# Contributing

TheWire is a personal project shared publicly. Issues are welcome for visibility, but reviews, merges and fixes aren't guaranteed. By contributing you agree your contribution is licensed under the repository's [license](LICENSE.md).

## Ground rules

These are hard constraints; a change that breaks one won't be merged.

- **TypeScript on Bun only.** No Python, no npm/npx scripts.
- **Zod is the only runtime dependency.** No new packages without a strong case.
- **`node:crypto` only** for any cryptography.
- **No CLI framework.** Argument parsing is manual (`src/cli/index.ts`).
- **Shell execution always asks first.** No auto-run, no silent fallback, no bypass.
- **Wire holds no credentials.** Never log, print or transmit keys or tokens.

## Development

```bash
bun install
bun test             # the full suite must stay green
bunx tsc --noEmit    # the type check must stay clean
```

- Add a test for every behaviour change.
- New CLI command: export `run<Name>` from `src/cli/<name>-cmd.ts` and register it in `src/cli/index.ts`.
- New message fields go through the Zod schemas in `src/schema/`.

## Security issues

Don't open a public issue. Use GitHub's **private vulnerability reporting** on this repository (Security tab → "Report a vulnerability").
