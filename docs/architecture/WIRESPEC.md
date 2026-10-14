# WireSpec — Agent-Native Task Language Reference

**Version:** 1.0.0
**Date:** 2026-06-30

---

## 1. What WireSpec is

WireSpec is the payload language inside WireProtocol v1 envelopes. It is NOT designed for human readability. It is designed for:

- **Zero inference overhead** — an agent consuming a WireSpec message reads typed fields, not English prose
- **Maximum semantic density** — typed primitives convey more meaning per token than natural language descriptions of the same task
- **Unambiguous routing** — verb + domain + output.format fully specifies what is needed without interpretation
- **Structured uncertainty** — agents can express what they know, what they don't, and how confident they are

---

## 2. Design Principles

### 2.1 Typed primitives over prose

English: "Please research the best SQLite indexing strategies for tables with ~100k rows under heavy read load, and give me a ranked list of options with trade-offs."

WireSpec:
```json
{
  "format": "task",
  "verb": "query",
  "domain": ["sqlite", "indexing", "performance"],
  "constraints": { "load": "read_heavy", "scale": "~100k_rows" },
  "output": {
    "format": "ranked-list",
    "maxItems": 5,
    "include": ["tradeoffs", "examples"]
  },
  "fallback": "best_effort"
}
```

The WireSpec version is ~40% fewer tokens. More importantly, it is unambiguous: an agent cannot misparse the output format requirement, the constraint values, or the facet list.

### 2.2 Domain as dot-notation path

The `domain` field uses dot-notation paths to position the task in a knowledge hierarchy:
- `"sqlite.indexing"` — SQLite, indexing subtopic
- `"python.typing.generics"` — Python, type system, generics
- `"architecture.api.rest"` — Architecture, API design, REST

Multiple domains are allowed: `["python", "testing", "pytest"]`

### 2.3 Output specification

The `output` field tells the receiving agent exactly what to produce:
- `format` — the structure of the response
- `maxItems` — upper bound for lists
- `include` — facets to include in each item
- `exclude` — facets to omit
- `maxTokens` — response budget
- `language` — for code output, the programming language

### 2.4 Confidence and uncertainty (ResultSpec)

Agents returning results must provide:
- `confidence` (0.0–1.0): how confident the agent is in the result
- `uncertainty` (string array): explicit items the agent is not certain about

This allows the receiving agent to decide whether to use the result as-is or request clarification.

---

## 3. Complete Type Reference

### 3.1 TaskVerb

| Verb | Meaning |
|------|---------|
| `query` | Look something up, research, retrieve information |
| `summarize` | Compress content while preserving key points |
| `implement` | Write code to specification |
| `review` | Evaluate quality, correctness, or fit against criteria |
| `verify` | Check whether a claim, output, or state is correct |
| `transform` | Convert content from one form to another |
| `classify` | Assign content to a category or taxonomy |
| `plan` | Produce a multi-step strategy or implementation plan |
| `explain` | Describe how or why something works |
| `debug` | Identify and propose a fix for a defect |

### 3.2 OutputFormat

| Format | Produces |
|--------|---------|
| `structured` | JSON object with named fields |
| `ranked-list` | Array of items ordered by relevance/quality |
| `prose` | Natural language paragraphs |
| `code` | Source code (use `language` field to specify) |
| `table` | Markdown table |
| `json` | Raw JSON, schema defined by sender |

### 3.3 ResultStatus

| Status | Meaning |
|--------|---------|
| `success` | Task completed, full result returned |
| `partial` | Task attempted, result is incomplete (see `uncertainty`) |
| `failed` | Task could not be completed (see `error`) |
| `needs_clarification` | Ambiguity prevents completion — sender must clarify |

### 3.4 HandoffReason

| Reason | Meaning |
|--------|---------|
| `capacity` | Agent at capacity, offloading to another agent |
| `specialization` | Task requires a skill this agent does not have |
| `cost` | Current agent is too expensive for this task tier |
| `policy` | Policy rule prevents this agent from handling the task |

### 3.5 ErrorCode

| Code | Meaning |
|------|---------|
| `schema_invalid` | Message failed Zod schema validation |
| `sig_invalid` | Ed25519 signature verification failed |
| `hmac_invalid` | HMAC-SHA256 integrity check failed |
| `nonce_replay` | Nonce was seen before within TTL window |
| `ttl_expired` | Message TTL has elapsed or clock skew > 300s |
| `key_not_found` | Sender's public key not in key store |
| `decrypt_failed` | AES-256-GCM decryption failed (wrong key or tampered ciphertext) |
| `agent_unavailable` | Target agent is not running or reachable |
| `unknown` | Unclassified error |

---

## 4. Examples

### 4.1 Code review task

```json
{
  "format": "task",
  "verb": "review",
  "domain": ["python", "fastapi", "security"],
  "subject": "auth middleware",
  "constraints": { "file": "src/middleware/auth.py", "focus": "injection,timing" },
  "output": {
    "format": "structured",
    "include": ["severity", "line", "issue", "fix"]
  },
  "fallback": "best_effort",
  "urgency": "soon"
}
```

### 4.2 Research result

```json
{
  "format": "result",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "confidence": 0.88,
  "data": [
    { "option": "Covering index", "tradeoff": "faster reads, larger disk" },
    { "option": "Partial index", "tradeoff": "smaller, limited to subset" }
  ],
  "uncertainty": ["row count estimate may affect recommendation"],
  "tokensUsed": 412
}
```

### 4.3 Handoff to specialist

```json
{
  "format": "handoff",
  "taskId": "550e8400-e29b-41d4-a716-446655440001",
  "reason": "specialization",
  "contextSummary": "React component needs TypeScript types wired to FastAPI schema",
  "artifacts": ["$HOME/projects/active/my-project/src/types.ts"],
  "resumePoint": "Wire AgentCard props to /api/agents endpoint response type"
}
```

### 4.4 Error response

```json
{
  "format": "error",
  "taskId": "550e8400-e29b-41d4-a716-446655440002",
  "code": "sig_invalid",
  "message": "Ed25519 signature verification failed for message from gemini",
  "retryable": false
}
```

---

## 5. Context References

When a task requires shared context (a file, a prior result, a research brief), agents use the `ctx` field in the envelope rather than embedding the context in the payload:

```
envelope.ctx = SHA-256(context_file_contents)
```

The receiving agent looks up the context artifact by hash from a shared context store (planned for v2). In v1, `ctx` is informational — the receiving agent uses it to verify they have the correct context artifact on disk.

---

## 6. Token Efficiency Rationale

Why WireSpec is more efficient for LLM-to-LLM communication:

1. **No parsing ambiguity** — typed fields eliminate the cognitive overhead of parsing English instructions. An LLM reading a TaskSpec can extract all parameters in a single pass.

2. **Constraint encoding** — `"constraints": { "load": "read_heavy" }` is 7 tokens. "for read-heavy workloads" is 5 tokens but requires inference to map to the same parameter.

3. **Output format specification** — `"format": "ranked-list", "maxItems": 5` is unambiguous. "give me a ranked list of up to 5 options" requires the model to count the constraint.

4. **Uncertainty channel** — `confidence` and `uncertainty` fields give the receiving agent structured metadata without requiring it to infer confidence from hedging language like "I think" or "this might be."

5. **Domain routing** — `"domain": ["sqlite", "indexing"]` allows a router to match against agent capabilities without parsing the full task body.

The Phase 8 benchmark measures this empirically against Ollama models.
