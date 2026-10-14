# Wire Platform Architecture
**Last updated:** 2026-07-01

---

## What this is

A personal AI presence — always available, privately owned, capable of acting on your behalf.

You speak plain English. It understands. It decides what to do — run a shell command, search the web, query a document, coordinate a specialist agent. It asks before anything consequential happens. It remembers what you've worked on. It doesn't start from zero each session.

**WireProtocol, the gateway, the router, the adapters — these are the nervous system. Wire Agent is the presence everything leads to.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      YOU (the user)                         │
│  speak plainly: "show me what's eating my disk"             │
└──────────────────────────┬──────────────────────────────────┘
                           │
               wire - <anything in English>
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                     NL DISPATCH                             │
│  isLinuxIntent() → system skill                             │
│  classifyExtended() → phi3.5 → skill/verb/subject/agent     │
│  keywordClassify() → instant fallback (no Ollama needed)    │
│  confidence gate: ≥85% silent · 60-84% confirm · <60% bail │
└──────┬────────────┬──────────┬───────────┬──────────────────┘
       │            │          │           │
  ┌────▼────┐ ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
  │ system  │ │ Gemini │ │ Ollama │ │ Claude │   workers
  │ shell   │ │ live   │ │ local  │ │ reason │
  │ HITL    │ │ search │ │ quick  │ │ complex│
  └────┬────┘ └────────┘ └────────┘ └────────┘
       │
  HITL gate: shows exact command → [y/N] → executes
```

---

## What is built

### Foundation

**Security (Layer 0)**
- Ed25519 per-agent signing (authentication)
- HMAC-SHA256 over canonical message (integrity)
- AES-256-GCM payload encryption via X25519 ECDH (confidentiality)
- Nonce + TTL replay prevention
- All keys local, mode 600. Never distributed, logged, or printed.
- Two-stage `.keys/` guard: `resolve()` + `realpathSync()` — blocks symlink attacks in RAG and proactive monitor

**Transport (Layer 1)**
- Filesystem: `.wire.json` files in `~/projects/inbox/`
- HTTP: Bun gateway on `127.0.0.1:31338`

**Protocol (Layer 2)**
- WireProtocol v1: typed, schema-validated message envelopes (Zod)
- WireSpec: compact payload language — 44.8% token reduction vs prose
- Gateway: signs on behalf of agents that can't hold private keys

**Router**
- Layer 1: Rule-based skill/verb/domain matching + EMA weight learning (α=0.2)
- Layer 2: phi3.5 semantic classifier — free-text in, structured routing out
- 19 routing rules including `system` skill → system agent
- Learned weights in `.wire-state/`

**Dispatch loop**
- Event-driven inbox watcher (Bun file watcher, not polling)
- Routes each incoming task via WireRouter, fires the right worker
- Workers: Ollama · Gemini · Codex · System
- SQLite dispatch state: message_id, status, agent, timestamps, result_ref
- HITL gate: consequential skills generate an approval request before proceeding

**Memory agent**
- SQLite-backed store: agent_id, session_id, ts, category, key, value, embedding (BLOB)
- Categories: conversation, task_log, project_state, preference, observation
- Keyword search + semantic search via nomic-embed-text embeddings (cosine similarity)

**RAG layer**
- Document ingest: `wire ingest <file>` — chunk, embed, store
- Semantic retrieval: cosine similarity via sqlite-vec
- `.keys/` guard: two-stage path check prevents reading key material via crafted paths

**Wire Agent core**
- Memory enrichment: relevant memory injected before every worker dispatch
- RAG enrichment: relevant document chunks retrieved for knowledge-class tasks
- Session brief: task history summary on startup with ✓/✗ per task

**Proactive monitor**
- Reads `.wire-state/projects.json` on every `dispatch start`
- Hashes STATUS.md per project, stores in `monitor.db`
- Reports new/updated/unchanged in session brief
- STATUS.md preview lines prefixed with `> ` to prevent content injection

**Natural language dispatch**
- `wire ask "<task>"` / `wire - <task>` — primary entry point
- phi3.5 classifies intent into skill, verb, subject, agent
- Confidence gate: ≥85% silent dispatch · 60-84% show plan + confirm · <60% bail
- Tiered retry: phi3.5 (45s) → phi3.5 + repair prompt (45s) → phi3:mini minimal (20s)
- Keyword fast-path: instant classification with no Ollama — always triggers plan+confirm
- Session-scoped result cache — same input never re-classifies within a process run

**Linux in plain English (`system` skill)**
- `isLinuxIntent()` — comprehensive regex covering 200+ Linux operation patterns across 15 categories
- Runs as final override after phi3.5 classification — catches paraphrases both classifier and keywords miss
- `generateShellCommand()` — Ollama converts NL to a single shell command
- HITL gate: shows exact command and requires `[y/N]` before any execution
- Safety blocklist: `rm -rf /`, fork bombs, disk wipes, filesystem format — blocked regardless of approval
- TTY guard: shell execution in non-interactive context fails with a clear error
- `system` skill flows through: classifier taxonomy → router table → dispatch worker → nl-cmd path
- In daemon context: generates command and returns it as a suggestion (cannot prompt non-interactively)

**Live search (`--live` flag)**
- Gemini API with `tools: [{ googleSearch: {} }]` — real-time web results
- Quota detection: reactive (API signals exhaustion) not counter-based
- Day-approval state: `.wire-state/paid-approved-YYYY-MM-DD` — persists across sessions
- Consent flow: `[y] this search / [a] all day / [n] cancel`
- Bypass dispatch queue — answers synchronously in terminal

**Web fetch (`wire fetch`)**
- HTTP GET → regex HTML strip → Ollama Q&A
- No external parsing deps — pure regex
- Ollama primary (free, local) · Gemini fallback if Ollama unavailable
- Works on server-rendered pages (Launchpad, docs, release pages, etc.)
- Does not execute JavaScript — use `--live` for JS-heavy pages

**CLI**
- `wire` — global command at `~/.local/bin/wire`
- `wire - <anything>` — shortest path to everything
- `wire ask "<task>"` — natural language dispatch
- `wire shell "<cmd>"` — explicit command with HITL gate
- `wire wakeup` — launch tmux 75/25 workspace
- `wire fetch "<url>" "<q>"` — page Q&A
- `wire task --to --skill --verb --subject` — structured dispatch
- `wire dispatch start|stop|status` — daemon management
- `wire memory search|list|get` — memory store
- `wire ingest <file>` / `wire rag search <q>` — RAG
- `wire route|classify` — router inspection
- `wire keygen|send|recv|verify|inspect` — protocol primitives

---

## Directory layout

```
src/
  types.ts              — all interfaces and enums (SkillType includes system)
  schema/               — Zod validators (WireMessage, TaskSpec, ResultSpec, HandoffSpec)
  crypto/               — keygen, keystore, sign, verify, encrypt, decrypt, nonce
  envelope/             — canonical serialization, encode/decode pipeline
  cli/
    index.ts            — main router (ask | - | shell | wakeup | fetch | task | ...)
    nl-cmd.ts           — `wire ask` / `wire -` NL dispatch + Linux intent path
    task-cmd.ts         — `wire task` structured dispatch
    shell-cmd.ts        — `wire shell` explicit command
    wakeup-cmd.ts       — `wire wakeup` tmux launch
    fetch-cmd.ts        — `wire fetch` page Q&A
    send.ts, recv.ts, verify-cmd.ts, inspect.ts, keygen.ts
  router/
    index.ts            — WireRouter (Layer 1 + Layer 2)
    classifier.ts       — phi3.5 classifier + isLinuxIntent() + keywordClassify()
    table.ts            — 19 routing rules + agent profiles (including system)
    history.ts          — EMA weight learning
    route-cmd.ts, classify-cmd.ts
  dispatch/
    loop.ts             — inbox watcher, task router, HITL gate
    workers.ts          — runOllama, runGemini, runCodex, runSystem
    db.ts               — SQLite dispatch state
  gateway/              — HTTP server :31338, auth, signing on behalf of agents
  agents/
    memory.ts           — SQLite memory store + embeddings
    rag.ts              — document ingest + cosine retrieval
    wire-agent.ts       — enrichment + session brief
    shell-worker.ts     — HITL gate, safety blocklist, generateShellCommand()
    web-fetch.ts        — HTTP GET + HTML strip + Ollama Q&A
    gemini-live.ts      — live search, quota detection, paid consent flow
    memory-cmd.ts, rag-cmd.ts
  proactive/            — monitor.ts (cross-project STATUS.md watcher)
  startup/              — index.ts (briefing), watch.ts, linux-context.ts
adapters/               — gemini.sh, codex.sh, ollama-bridge.ts, gemini-direct.ts
tests/                  — bun test suites (run `bun test` for current count; do not hardcode a number here, it drifts every phase)
docs/                   — ARCHITECTURE.md, PROTOCOL.md, SECURITY.md, WIRESPEC.md, ONBOARDING.md
benchmark/              — token efficiency comparison
bin/                    — wire (bash shim), wire-tmux, wire-up
.keys/                  — Ed25519 + X25519 keypairs (mode 600 sk, mode 700 dir)
.wire-state/            — nonce replay store, dispatch state, monitor.db, projects.json, paid-approved-*
```

---

## Agent roster

| Agent | Role | Status |
|-------|------|--------|
| Wire Agent | Personal presence — enriches context, orchestrates workers, session brief | Built |
| claude | Complex reasoning, architecture, security, implementation | Active |
| gemini | Research, large-context synthesis, GCP, live web search | Active |
| codex | Code generation, scaffolding, TypeScript | Active |
| ollama | Summarize, classify, quick tasks, command generation (local, free) | Active |
| system | Linux/shell execution — NL→command via Ollama, HITL gate before run | Active |

---

## Local model set

| Model | Org | Size | Role |
|-------|-----|------|------|
| phi3:mini | Microsoft | 2.2GB | quick/summarize, NL dispatch tier-3 fallback |
| phi3.5 | Microsoft | 2.2GB | Layer 2 classifier, NL dispatch primary, command generation |
| codegemma:2b | Google | 1.6GB | code review/debug |
| nomic-embed-text | Nomic AI | 274MB | embeddings for memory + RAG |

Hardware: WSL2, 4GB RAM cap, no GPU. One model active at a time. All ≤3GB active footprint.

Model policy: trusted Western organizations only (Microsoft, Google, Nomic AI). No Chinese-based models regardless of benchmark performance.

---

## Security model

- Authentication: Ed25519 per-agent keypairs. Sender signs, recipient verifies.
- Integrity: HMAC-SHA256 over canonical message.
- Confidentiality: AES-256-GCM, key via X25519 ECDH.
- Replay prevention: nonce (16-byte random) + timestamp + TTL.
- HITL: all shell execution requires explicit `[y/N]` approval before any command runs.
- Shell safety blocklist: `rm -rf /`, fork bombs, disk wipes, filesystem format — rejected before even showing HITL prompt.
- TTY guard: shell execution fails hard in non-interactive contexts — no silent bypass.
- Private keys: `.keys/*.sk` — never logged, printed, returned in responses, or distributed.
- Path traversal guard: two-stage resolution (`resolve()` + `realpathSync()`) in RAG and proactive monitor.

---

## Backlog (no timeline, clear trigger to revisit)

| Item | Trigger |
|------|---------|
| `wire weather <zipcode>` | wttr.in integration — free, no API key, ZIP code native |
| MCP server | Expose Wire tools as MCP endpoints for Claude Desktop / other clients |
| Scheduler agent | After dispatch proven stable for 2 weeks |
| Vault agent | When secret count > 5 or per-agent ACL is genuinely needed |
| Router Layer 3 (ReAct) | After dispatch loop proven for 2 weeks |
| A2A bridge | When Wire Platform needs to coordinate with external agents |
| Phi-4-Mini upgrade | Measure RAM headroom after dispatch + memory are stable |
| .bashrc auto-start | After 2 weeks of stable wire-start operation |
| Comms agent (email/calendar) | After memory agent gives it context to work with |
| NL→shell routing via dispatch | Design trust model for daemon-generated commands |
