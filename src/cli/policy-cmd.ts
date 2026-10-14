import { formatProviderPolicy } from "../router/providerPolicy.js";
import { buildProviderFallbackPlan, formatProviderFallbackPlan } from "../router/providerFallback.js";
import type { RuntimeFailureReason } from "../router/providerFallback.js";
import type { AgentId } from "../types.js";

const KNOWN_PROVIDER_AGENTS = new Set<AgentId>(["claude", "gemini", "codex", "ollama", "system", "llama4", "deepseek"]);

function parseAgent(raw: string | undefined, flag: string): AgentId {
  if (raw && KNOWN_PROVIDER_AGENTS.has(raw as AgentId)) return raw as AgentId;
  console.error(`${flag} requires one of: ${[...KNOWN_PROVIDER_AGENTS].join(", ")}`);
  process.exit(1);
}

function parseFailed(raw: string | undefined): Partial<Record<AgentId, RuntimeFailureReason>> {
  const states: Partial<Record<AgentId, RuntimeFailureReason>> = {};
  if (!raw) return states;

  for (const entry of raw.split(",")) {
    const [agentRaw, reasonRaw] = entry.split(":");
    const agent = parseAgent(agentRaw, "--failed");
    const reason = reasonRaw ?? "failed";
    if (!["not_running", "auth_missing", "quota_exhausted", "usage_exhausted", "failed", "policy_blocked", "timeout"].includes(reason)) {
      console.error(`Unknown failure reason "${reason}". Use not_running, auth_missing, quota_exhausted, usage_exhausted, failed, policy_blocked, or timeout.`);
      process.exit(1);
    }
    states[agent] = reason as RuntimeFailureReason;
  }
  return states;
}

function printUsage(): void {
  console.log("Usage: wire policy [fallback <skill> --parent <agent> --failed <agent:reason,...>]");
  console.log("");
  console.log("  wire policy");
  console.log("  wire policy fallback research --parent codex --failed gemini:quota_exhausted");
  console.log("  wire policy fallback implement --parent gemini --failed claude:not_running,codex:usage_exhausted");
  console.log("");
  console.log("Failure reasons: not_running, auth_missing, quota_exhausted, usage_exhausted, failed, policy_blocked, timeout");
}

export async function runPolicy(args: string[]): Promise<void> {
  if (args[0] === "fallback") {
    const skill = args[1];
    if (!skill) {
      printUsage();
      process.exit(1);
    }

    let parent: AgentId = "claude";
    let failed = "";
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--parent") {
        parent = parseAgent(args[++i], "--parent");
      } else if (args[i] === "--failed") {
        failed = args[++i] ?? "";
      } else {
        console.error(`Unknown option: ${args[i]}`);
        printUsage();
        process.exit(1);
      }
    }

    console.log(formatProviderFallbackPlan(buildProviderFallbackPlan({
      skill,
      parentAgent: parent,
      states: parseFailed(failed),
    })));
    return;
  }

  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  if (args.length > 0) {
    console.error(`Unknown policy subcommand: ${args[0]}`);
    printUsage();
    process.exit(1);
  }

  console.log(formatProviderPolicy());
}
