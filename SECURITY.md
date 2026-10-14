# Security

Wire runs AI-chosen actions on your own computer, so its security model starts from one rule: **nothing consequential happens without you.** This page states what Wire guarantees, how, and where the limits are.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security tab → "Report a vulnerability"). Please don't open a public issue.

## Threat model

| Asset | Threat | Protection |
|---|---|---|
| Your shell | A model, a prompt-injected document or a crafted request turns into a destructive command | Every command goes through one approval gate (`src/agents/shell-worker.ts`). It is shown exactly as it will run, with control characters and terminal escapes made visible, and runs only after you type `y`. No terminal means refused. A blocklist (wiping `/` or `~`, disk writes, `mkfs`, fork bombs, `find / -delete`) refuses even approved commands. |
| Your files | An MCP client or model writes outside a project, directly or through a symbolic link | `project_write` (`src/projects/security.ts`) checks the real, link-resolved path against the project root and an allowed-folder list, refuses symbolic-link targets, and opens files without following links. |
| Your API keys | Keys leak to another vendor's tool, into logs, or into the document store | Wire ships with no keys. Child CLIs get an environment with Wire's keys removed, except their own vendor's (`src/dispatch/spawnAsync.ts`). `.env`, `.keys/` and `.wire-state/` are git-ignored, and `wire ingest` refuses them. |
| Your network | Something on the network reaches Wire's services | The optional gateway binds to `127.0.0.1` only, needs a token, and limits request size to 1 MB. The MCP server uses stdio, not a network port. |
| Your money | A request silently moves to a paid service | Live search asks for consent before Gemini's paid tier. Requests to `claude`, `codex` and `agy` use your own plans; choose them explicitly with `--to` if you want full control. |

## What Wire does not protect against

- **A command you approve runs with your full user permissions.** Read it before typing `y`. The blocklist is a backstop, not a sandbox.
- **Model output can be wrong or steered.** Text returned by a model or tool may contain instructions planted in the documents it read. Wire screens incoming text for known injection and secret patterns, but this is a best-effort filter.
- **Other local programs running as you** can read the same files Wire can.
- **Message envelopes are not signed** in 1.1.0. Wire trusts the local filesystem; it is built for one machine and one user.
- **Third-party tools** (`claude`, `codex`, `agy`, Ollama, Gemini, Groq) are governed by their own security and terms.

## Hardening tips

- Keep `.env` at mode `600` and `.keys/` at `700` (`chmod 600 .env; chmod 700 .keys`).
- Use `--to ollama` for anything private you don't want to leave your machine.
- Run `wire status` to see exactly which services are running.
- Don't run the dispatch daemon from inside another AI agent's session.

## Fixes in 1.1.0

- `project_write` could be redirected through a symbolic link. Fixed.
- Wire's own API keys reached the vendor CLIs it runs. Fixed.
- Control characters could disguise a command at the approval prompt. Fixed.
- `wire ingest` accepted `.env` files. Fixed.
- The MCP `wire_work` tool accepted a flag-like project name. Fixed.
- An unused shell tool without its own approval gate has been switched off.

See the [CHANGELOG](CHANGELOG.md).

## No warranty

Wire is provided **as is**, without warranty of any kind, under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You are responsible for how you use it.
