// agentAllowlist.ts — optional operator allowlist for which agents may do work.
//
// WIRE_ROUTING_AGENTS=claude,codex,antigravity restricts routing and dispatch
// to those agents. Unset (the default) leaves every agent enabled, so public
// installs are unchanged. `system` (the local shell executor, not a model) is
// always allowed. Read on every call so a service restart is the only thing
// needed to change it.

import type { AgentId } from "../types.js";

export function routingAllowlist(env: NodeJS.ProcessEnv = process.env): Set<AgentId> | null {
  const raw = env["WIRE_ROUTING_AGENTS"]?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map(a => a.trim()).filter(Boolean) as AgentId[]);
}

export function isAgentAllowed(agent: AgentId, env: NodeJS.ProcessEnv = process.env): boolean {
  if (agent === "system") return true;
  const allow = routingAllowlist(env);
  return !allow || allow.has(agent);
}
