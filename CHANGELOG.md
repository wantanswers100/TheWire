# Changelog

Every merge to `main` is a release and gets exactly one new version number here,
in `package.json`, and as a git tag `vX.Y.Z` (same tag on the public mirror).
Newest first. `tests/version.test.ts` fails if the top entry and `package.json` disagree.

Numbering ([SemVer](https://semver.org)):
- **patch** `1.1.0 → 1.1.1` — fixes only
- **minor** `1.1.0 → 1.2.0` — new commands or behaviour
- **major** `1.x → 2.0.0` — breaking changes to commands, config, or the MCP/gateway API

The message-envelope protocol ("WireProtocol v1", `WIRE_VERSION` in `src/types.ts`)
is versioned separately and does not change with releases.

Detailed engineering notes for each change live in `DEVLOG.md`.

## 1.1.1 — 2026-10-14

### Fixed
- `wire task --help` (and `--help` on `ask`, `-`, `work`, `shell`, `fetch`, `memory`, `rag`) no longer starts the gateway and the dispatch daemon in the background before printing help.

## 1.1.0 — 2026-10-14

### Security
- `project_write` (MCP) no longer follows symlinks: a link inside `outputs/` or `context/` could
  redirect a write to any file you own. Paths are now checked at their real location and written
  without following links.
- Wire's own API keys (`.env`) are no longer passed to the Claude, Codex and agy CLIs it runs;
  each CLI keeps only its own vendor's key.
- The shell approval prompt shows hidden control characters, so a command can't disguise itself.
  The safety blocklist also catches `rm -rf /*`, `rm -rf ~`, `find / -delete` and `dd` onto any device.
- `wire ingest` refuses `.env` files and Wire's state folder. The MCP `wire_work` tool rejects a
  project name that looks like a flag. An unused shell tool with no approval gate is switched off.

### Fixed
- Yes/no prompts work in a real terminal and refuse cleanly anywhere else. They were crashing: the shell approval, `Dispatch?`, paid-search consent, `wire update` and `wire cron del` all read input in a way Bun does not support.
- `--help` and `-h` always print help and never run the command. `wire keygen --help` used to create a key pair named `--help`. Plain-English text keeps its flags: `wire - what does ls -h do` runs as a task.
- An explicit `--to <agent>` no longer stops to ask `Dispatch? [y/N]`. Over MCP, `wire_ask` with `to` now returns an answer instead of a prompt nobody can see. `--confirm` still asks.
- `wire` and `wire-up` work for any user and install folder (they had the author's home path built in).
- `wire update` exits with an error when `bun install` or the new version fails, instead of printing "Updated."
- A shell command no longer keeps the CLI open for up to 30s after it finishes.
- Codex results from a run that exited with an error are marked partial instead of reported as clean.
- A shell-approval request that can't be delivered now fails the task instead of leaving it waiting forever.
- Claude worker (`claude -p`) no longer loads every MCP server and claude.ai connector, runs on
  Sonnet instead of the CLI default (Opus), and skips the advisor and skill list — about 66% less
  context per call, and no ~230k connector tool-definition jump in headless sessions.
- Local qwen3 models returned empty replies (output landed in Ollama's `thinking`
  field; the `/no_think` prompt hint is ignored). Every Ollama request now disables
  thinking explicitly. This was behind the classifier's "JSON Parse error: Unexpected
  EOF" and the ~95s "routing via qwen3:4b" waits.
- Quality judge (PhaseGate) counted empty replies as passes. It now returns real
  pass/fail verdicts (JSON-constrained) and records empty replies as "skipped".
- Plain-English dispatch: classification drops from ~95s to ~11–13s once the model
  is loaded (prompt reordered so its fixed part is cached).
- The backup classifier can no longer trigger a silent dispatch; its results always
  show the plan and ask first.
- `--to <agent>` skips the local classifier (it was unused anyway).
- Provider model defaults come from one config instead of duplicated literals.
- Restored a missing import in the MCP project-write guard (`security.ts`) that broke the type check.

### Added
- `wire version` checks GitHub for a newer release; `wire update` moves to it after asking
  (clean `main` only, fast-forward only, then `bun install`).
- Version details at start-up: `wire --version`, the `wire` banner, `wire status` and
  `wire-start` show release, date, commit, branch, and whether the running code is
  unreleased or has uncommitted changes.
- `wire engaged` — shows when Wire is in use and by which CLI (terminal, Claude Code,
  Codex, agy). Claude Code's status line shows a `wire▸` badge only while a call runs.
- README sections on using Wire from a terminal, Claude Code and Codex.
- `wire - weather in <place>` answers locally via the free `wire weather` instead of
  dispatching to an AI agent.
- Routing spinner shows elapsed seconds.
- `wire help terms` — plain-language glossary (the security reviewer and the other release reviewers,
  PhaseGate, HITL, QA/UAT, versions …); `wire help terms <word>` for one entry.

### Changed
- Unknown commands print a short error with a suggestion (`wire stop` →
  `wire dispatch stop`) instead of the full help screen.
- `wire status` lists only real projects under `active/`.
- Help text keeps a gap between long command names and their descriptions.
- MCP `project_write` / `project_search` allowlist widened to profile, snapshot and question folders (still canonical-path validated).
- Pre-commit hook now runs `tsc --noEmit` as well as the tests.
- Stale docs archived, including the pre-Phase-43 security model that no longer matched the code.
- License: PolyForm Noncommercial 1.0.0 (as already published), now also in the source repository. New README, FAQ, SECURITY and CONTRIBUTING.
- Settings for your own installation (Codex approver name, daily briefing, your project names for document search) live in git-ignored `.wire-state/local.json` and `.wire-state/project-entities.json` instead of the code.
- The public repository now holds one clean commit per release. Clones made before 1.1.0 need a fresh clone once.

## 1.0.0 — 2026-09-25

First public release (TheWire mirror). Baseline for all later versions — see
`DEVLOG.md` for the history before versioned releases.
