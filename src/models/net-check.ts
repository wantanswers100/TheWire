// Network availability check — lightweight probe used before API dispatch.
// Does NOT check any specific provider — only confirms internet connectivity.

export interface NetCheckResult {
  available: boolean;
  latencyMs: number;
  error?: string;
}

// Fast DNS-based check — resolves in <200ms when online, fails immediately when offline.
// Uses 1.1.1.1 (Cloudflare) via HTTPS to avoid corporate proxies that intercept DNS.
const PROBE_URL = "https://1.1.1.1";
const PROBE_TIMEOUT_MS = 2500;

export async function checkNetwork(): Promise<NetCheckResult> {
  const t0 = Date.now();
  try {
    await fetch(PROBE_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return { available: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return {
      available: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ModelAvailability — per-provider status for UI display
export type ModelStatus =
  | "available"       // key present + network up + service responding
  | "no-key"          // API key not configured (no network check attempted)
  | "no-network"      // key present but no internet connectivity
  | "offline-ok"      // local model (Ollama/system) — no network needed, service up
  | "offline-down"    // local model but Ollama not running
  | "unconfigured"    // not yet set up (planned provider)
  | "quota_exceeded"  // key present, API up, but 429 — quota/rate limit hit
  | "auth_error"      // key present, API up, but 401/403 — key invalid or revoked
  | "service_error"   // API up, authenticated, but 5xx — provider-side technical issue
  | "model_deprecated"; // model name rejected by API — may have been renamed or retired

export interface ModelAvailability {
  id: string;
  name: string;
  status: ModelStatus;
  reason?: string;     // human-readable explanation when not available
  latencyMs?: number;
}

export function statusLabel(s: ModelStatus): string {
  switch (s) {
    case "available":        return "available";
    case "no-key":           return "API key not set";
    case "no-network":       return "no network connection";
    case "offline-ok":       return "running (local)";
    case "offline-down":     return "offline (start with: ollama serve)";
    case "unconfigured":     return "not configured";
    case "quota_exceeded":   return "quota exceeded (check provider dashboard)";
    case "auth_error":       return "auth error — key invalid or revoked";
    case "service_error":    return "service error — provider-side issue";
    case "model_deprecated": return "model name rejected — may be renamed or retired";
  }
}

export function statusIsExternal(s: ModelStatus): boolean {
  return s === "quota_exceeded" || s === "service_error" || s === "model_deprecated";
}

export function statusIsFixable(s: ModelStatus): boolean {
  return s === "no-key" || s === "auth_error" || s === "offline-down" || s === "unconfigured";
}

export function isUsable(s: ModelStatus): boolean {
  return s === "available" || s === "offline-ok";
}

// Classify a raw HTTP response status code into a ModelStatus
export function httpStatusToModelStatus(httpStatus: number): ModelStatus {
  if (httpStatus === 200) return "available";
  if (httpStatus === 401 || httpStatus === 403) return "auth_error";
  if (httpStatus === 429) return "quota_exceeded";
  if (httpStatus === 404) return "model_deprecated"; // model not found at API = likely renamed
  if (httpStatus >= 500) return "service_error";
  return "service_error";
}
