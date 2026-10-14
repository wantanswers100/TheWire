// Prompt injection guard — sanitize user-controlled or file-sourced text
// before it is injected into LLM prompts.
//
// Targets the most common prompt injection patterns without over-filtering
// legitimate content. Each match is replaced with [FILTERED] and a warning
// is emitted to stderr.
//
// Reference: Microsoft Security Blog, May 2026 — #1 AI agent attack vector

const PATTERNS: Array<{ re: RegExp; name: string }> = [
  // Instruction override patterns
  // The qualifier group is `*`, not `?` — it must match STACKED qualifiers.
  // Found 2026-09-09 by a test written for the ISS-060 tiering work: with `?`
  // (exactly one optional qualifier) the guard caught "ignore all instructions"
  // and "ignore previous instructions" but MISSED "ignore all previous
  // instructions" — the single most common phrasing of this attack — and
  // likewise missed "ignore any prior rules" and "disregard all previous
  // instructions". Pre-existing gap, unrelated to ISS-060; caught only because
  // the new tests exercised the always-on patterns explicitly.
  {
    re: /\bignore\s+(?:all\s+|the\s+|my\s+|any\s+|previous\s+|above\s+|prior\s+|these\s+|those\s+)*(?:instructions?|directives?|rules?|commands?|context|constraints?|guidelines?)\b/gi,
    name: "ignore-instructions",
  },
  {
    re: /\bdisregard\s+(?:all\s+|the\s+|my\s+|any\s+|previous\s+|above\s+|prior\s+|these\s+|those\s+)*(?:instructions?|directives?|rules?|commands?|context|constraints?|guidelines?)\b/gi,
    name: "disregard-instructions",
  },
  {
    re: /\bforget\s+(?:everything|all|previous|above|prior|the\s+context|what\s+I\s+said)\b/gi,
    name: "forget-context",
  },
  // Role override patterns
  {
    re: /\byou\s+are\s+now\s+(?:a\s+|an\s+)?/gi,
    name: "role-override",
  },
  {
    // ISS-060 (2026-09-09): the original pattern matched ANY "act as a/an <noun>",
    // which is ordinary, benign task-framing language ("act as a skeptical auditor")
    // — verified false-positive on a direct wire_ask task string. This narrow form
    // catches explicit jailbreak framing and is safe to apply to ALL sources; the
    // broad form still applies to untrusted sources via STRICT_ONLY_PATTERNS below.
    re: /\bact\s+as\s+(?:a\s+|an\s+)?(?:unrestricted|unfiltered|uncensored|unbound|unlimited|jailbroken|evil|amoral|without\s+(?:rules|restrictions|limits|guidelines|filters)|dan\b|developer\s+mode)/gi,
    name: "act-as",
  },
  // New instruction injection
  {
    re: /\bnew\s+(?:instructions?|directives?|commands?|objective)\s*:/gi,
    name: "new-instructions",
  },
  // System prompt reference
  {
    re: /\bsystem\s+prompt\b/gi,
    name: "system-prompt-ref",
  },
  // LLM special tokens (model-specific control sequences)
  {
    re: /<\|(?:system|assistant|user|im_start|im_end)\|>/g,
    name: "llm-control-token",
  },
  {
    re: /\[(?:INST|\/INST|SYS|\/SYS)\]/g,
    name: "llm-inst-token",
  },
  // Prompt delimiter spoofing
  {
    re: /={3,}\s*(?:SYSTEM|PROMPT|INSTRUCTION|OVERRIDE|JAILBREAK)\s*={3,}/gi,
    name: "prompt-delimiter-spoof",
  },
];

// Source labels denoting text typed directly by the operator (or by the agent
// driving this session) rather than content read out of a file, inbox handoff,
// or web page. Anything NOT listed here is treated as untrusted and additionally
// gets STRICT_ONLY_PATTERNS — an unrecognized source label therefore defaults to
// strict, so a future call site is fail-safe rather than fail-open.
const DIRECT_INPUT_SOURCES = new Set(["task input", "shell NL request"]);

// Applied to untrusted (file / handoff / web-sourced) text ONLY.
//
// Deliberately broad. The tradeoff genuinely inverts by source: for content the
// operator never typed, a false positive costs one [FILTERED] span in a prompt,
// while a false negative can carry an attacker-authored instruction into an LLM
// call. For text the operator typed themselves, that same breadth mangles benign
// task descriptions — guardPrompt() *mutates* the string, so an over-broad match
// silently corrupts the task before it is ever classified (the ISS-060 failure).
const STRICT_ONLY_PATTERNS: Array<{ re: RegExp; name: string }> = [
  {
    // The original broad act-as rule, preserved verbatim for untrusted sources:
    // "act as a system administrator and ..." must still be caught in a handoff
    // file even though it is benign framing in an operator-typed task.
    re: /\bact\s+as\s+(?:a\s+|an\s+)?(?!\w+\.)/gi,
    name: "act-as-broad",
  },
];

export interface SanitizeResult {
  text: string;
  injectionDetected: boolean;
  findings: string[];
}

// Secret patterns to detect in context pack content before online escalation.
// Warn-and-block: if matched, the escalation is aborted to prevent leaking
// credentials to an online model.
const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
  // Hyphens/underscores are intentional in the body class. The original
  // /\bsk-[a-zA-Z0-9]{20,}\b/ required 20+ ALPHANUMERIC chars after "sk-",
  // which silently missed every modern key format, because they carry a
  // hyphenated prefix that breaks the run: "sk-proj-..." (current OpenAI)
  // and "sk-ant-api03-..." (Anthropic) both stop the match at 4 chars.
  // Found by scripts/stress-test.ts (Phase 50) — the scanner is fail-closed
  // (agentPickup quarantines the row; prep-online exits 1), so a miss meant
  // real credentials could reach a remote provider. A false positive only
  // blocks one dispatch with a legible reason, so erring wide is correct here.
  { re: /\bsk-[a-zA-Z0-9_-]{20,}\b/g, name: "openai-style-key" },
  { re: /\bAKIA[A-Z0-9]{16}\b/g, name: "aws-access-key" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, name: "private-key-pem" },
  {
    re: /\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|BEARER_TOKEN|CLIENT_SECRET)\s*=\s*\S{8,}/g,
    name: "env-secret-assignment",
  },
];

export interface SecretScanResult {
  secretsFound: boolean;
  findings: string[];
}

/**
 * Scan content for secret patterns before passing to an online model.
 * Returns findings but does NOT modify the content — caller decides how to handle.
 */
export function scanForSecrets(content: string, source: string): SecretScanResult {
  const findings: string[] = [];
  for (const { re, name } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(content)) {
      findings.push(name);
    }
    re.lastIndex = 0;
  }
  if (findings.length > 0) {
    process.stderr.write(
      `[wire:security] Secret pattern(s) detected in ${source}: ${findings.join(", ")}\n`,
    );
  }
  return { secretsFound: findings.length > 0, findings };
}

/**
 * Sanitize text before injection into an LLM prompt.
 * @param raw   The raw text to sanitize (user input or file content)
 * @param source  A label for logging (e.g. "task input", "CONTEXT.md")
 */
export function sanitizeForPrompt(raw: string, source: string): SanitizeResult {
  let text = raw;
  const findings: string[] = [];

  // Untrusted sources (anything not an explicit direct-input label) additionally
  // get the broad pattern set. Default-strict: an unknown label is treated as
  // untrusted, never as direct input.
  const activePatterns = DIRECT_INPUT_SOURCES.has(source)
    ? PATTERNS
    : [...PATTERNS, ...STRICT_ONLY_PATTERNS];

  for (const { re, name } of activePatterns) {
    re.lastIndex = 0;
    if (re.test(text)) {
      findings.push(name);
      re.lastIndex = 0;
      text = text.replace(re, "[FILTERED]");
    }
    re.lastIndex = 0;
  }

  if (findings.length > 0) {
    process.stderr.write(
      `[wire:security] Prompt injection patterns detected in ${source}: ${findings.join(", ")}\n`,
    );
  }

  return { text, injectionDetected: findings.length > 0, findings };
}

/**
 * Sanitize and return just the cleaned text — convenience wrapper.
 */
export function guardPrompt(raw: string, source: string): string {
  return sanitizeForPrompt(raw, source).text;
}
