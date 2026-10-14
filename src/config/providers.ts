// Provider registry — Wire Platform
//
// Single source of truth for every AI provider Wire dispatches to:
//   - doc URLs (check these when a model stops responding)
//   - models page URL (check this when investigating upgrades)
//   - model IDs Wire currently uses from this provider
//   - known deprecated model IDs (never route to these)
//   - tier + notes
//
// To investigate a provider manually:
//   wire providers check groq
//   wire providers check gemini
//   wire providers list
//
// To apply an upgrade:
//   wire providers upgrade gemini --model gemini-3.7-flash   (writes GEMINI_DEFAULT to .env)
//   wire providers upgrade groq   --fast openai/gpt-oss-20b   (writes LLAMA4_FAST to .env)

import {
  LLAMA4_FAST,
  LLAMA4_CAPABLE,
  DEEPSEEK_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  OLLAMA_SKILL_MODEL,
  OLLAMA_DEFAULT_MODEL,
  EMBED_MODEL,
} from "./models.js";

export type ProviderId = "groq" | "gemini" | "ollama";
export type ProviderTier = "local" | "free-tier" | "low-cost" | "paid";

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  tier: ProviderTier;
  docsUrl: string;
  modelsUrl: string;
  wireModels: string[];
  knownDeprecated: string[];
  upgradeEnvVars: Record<string, string>;
  notes: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "groq",
    name: "Groq",
    tier: "free-tier",
    docsUrl: "https://console.groq.com/docs/overview",
    modelsUrl: "https://console.groq.com/docs/models",
    wireModels: [LLAMA4_FAST, LLAMA4_CAPABLE],
    knownDeprecated: [
      "llama-3.3-70b-versatile",        // removed 2026-08-17 (HTTP 404)
      "llama-3.1-8b-instant",            // removed from free tier 2026-06-17
      "deepseek-r1-distill-llama-70b",   // deprecated by Groq 2025-10-02
    ],
    upgradeEnvVars: {
      LLAMA4_FAST,
      LLAMA4_CAPABLE,
      DEEPSEEK_MODEL: DEEPSEEK_DEFAULT_MODEL,
    },
    notes: "Free tier: 250K TPM, 1K RPM. gpt-oss-20b (fast, 1K t/s) + gpt-oss-120b (capable, 500 t/s). groq/compound + groq/compound-mini available as preview compound systems.",
  },
  {
    id: "gemini",
    name: "Gemini",
    tier: "low-cost",
    docsUrl: "https://ai.google.dev/gemini-api/docs/interactions-overview",
    modelsUrl: "https://ai.google.dev/gemini-api/docs/latest-model",
    wireModels: [GEMINI_DEFAULT_MODEL],
    knownDeprecated: [
      "gemini-2.0-flash",   // retired 2026-08-11
    ],
    upgradeEnvVars: {
      GEMINI_DEFAULT: GEMINI_DEFAULT_MODEL,
    },
    notes: `Latest GA: ${GEMINI_DEFAULT_MODEL} (1M ctx, 64K out, $0.75/1M input through Dec 2026). Live search via googleSearch grounding tool. Interactions API is the forward path for agentic/multimodal features — monitor for migration.`,
  },
  {
    id: "ollama",
    name: "Ollama",
    tier: "local",
    docsUrl: "https://docs.ollama.com",
    modelsUrl: "https://ollama.com/search",
    wireModels: [
      OLLAMA_DEFAULT_MODEL,
      OLLAMA_SKILL_MODEL.classify ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_SKILL_MODEL.code_review ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_SKILL_MODEL.deepseek ?? OLLAMA_DEFAULT_MODEL,
      EMBED_MODEL,
    ],
    knownDeprecated: [],
    // Same `?? OLLAMA_DEFAULT_MODEL` fallback dispatch/workers.ts already
    // uses for this same map (models.ts's OLLAMA_SKILL_MODEL is typed
    // Record<string, string>, so noUncheckedIndexedAccess makes every
    // lookup `string | undefined` even though these specific keys always
    // exist in the object literal) — verified by running tsc, not assumed.
    upgradeEnvVars: {
      OLLAMA_QUICK:        OLLAMA_SKILL_MODEL.quick ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_SUMMARIZE:    OLLAMA_SKILL_MODEL.summarize ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_CLASSIFY:     OLLAMA_SKILL_MODEL.classify ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_EXPLAIN:      OLLAMA_SKILL_MODEL.explain ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_LOCAL_REASON: OLLAMA_SKILL_MODEL.local_reason ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_CODE_REVIEW:  OLLAMA_SKILL_MODEL.code_review ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_DEBUG:        OLLAMA_SKILL_MODEL.debug ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_LOCAL_CODE:   OLLAMA_SKILL_MODEL.local_code ?? OLLAMA_DEFAULT_MODEL,
      OLLAMA_LOCAL_REVIEW: OLLAMA_SKILL_MODEL.local_review ?? OLLAMA_DEFAULT_MODEL,
    },
    notes: "Local self-hosted — no API key, no egress. Ollama Cloud (ollama.com/api/) available for larger models without local GPU (requires OLLAMA_API_KEY). Use `wire modelupdate` for local pulls and upgrade suggestions.",
  },
];

export function getProvider(id: ProviderId): ProviderSpec {
  const p = PROVIDERS.find(p => p.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
