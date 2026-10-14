// Router learning history — tracks result quality per (skill, domain, agent)
// so routing weights drift toward agents that consistently succeed.
//
// Storage: .wire-state/router-history.json
// Weights:  .wire-state/router-weights.json
//
// Learning algorithm: exponential moving average (EMA) on success rate.
//   weight_new = α * outcome + (1 - α) * weight_old
//   α = 0.2  (slow adaptation — prevents thrashing on single bad result)
//   outcome: success=1.0, partial=0.5, failed=0.0

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RoutingHistoryEntry, RoutingWeights } from "./types.js";

const EMA_ALPHA = 0.2;
const MAX_HISTORY = 500;       // cap file size, drop oldest

export class RouterHistory {
  private historyPath: string;
  private weightsPath: string;

  constructor(stateDir: string) {
    this.historyPath = join(stateDir, "router-history.json");
    this.weightsPath = join(stateDir, "router-weights.json");
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  loadHistory(): RoutingHistoryEntry[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      return JSON.parse(readFileSync(this.historyPath, "utf8")) as RoutingHistoryEntry[];
    } catch (e) {
      console.error(`[router/history] history file corrupt, resetting to baseline: ${e}`);
      return [];
    }
  }

  loadWeights(): RoutingWeights {
    if (!existsSync(this.weightsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.weightsPath, "utf8")) as RoutingWeights;
    } catch (e) {
      console.error(`[router/history] weights file corrupt, resetting to baseline: ${e}`);
      return {};
    }
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  record(entry: RoutingHistoryEntry): void {
    const history = this.loadHistory();
    history.push(entry);

    // Keep only the most recent MAX_HISTORY entries
    const trimmed = history.length > MAX_HISTORY
      ? history.slice(history.length - MAX_HISTORY)
      : history;

    writeFileSync(this.historyPath, JSON.stringify(trimmed, null, 2), { encoding: "utf8", mode: 0o600 });

    // Update weights via EMA
    this.updateWeights(entry);
  }

  // ── Weight scoring ──────────────────────────────────────────────────────────

  // Returns a weight bonus [0.0–0.3] for (agent, skill, domain) triplet.
  // Added to the base rule score to allow learned preferences to shift routing.
  weightBonus(agent: string, skill: string, domains: string[]): number {
    const weights = this.loadWeights();
    const domainKeys = domains.length > 0 ? domains : ["_any"];

    let total = 0;
    let count = 0;
    for (const domain of domainKeys) {
      const key = `${skill}:${domain}:${agent}`;
      if (key in weights) {
        total += weights[key]!;
        count++;
      }
    }

    if (count === 0) return 0;
    // Scale 0.0–1.0 weight to 0.0–0.3 bonus range
    return ((total / count) - 0.5) * 0.6;   // positive when above 0.5 baseline
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private updateWeights(entry: RoutingHistoryEntry): void {
    const weights = this.loadWeights();
    const outcome = entry.status === "success" ? 1.0
      : entry.status === "partial" ? 0.5
      : 0.0;

    const domainKeys = entry.domains.length > 0 ? entry.domains : ["_any"];
    for (const domain of domainKeys) {
      const key = `${entry.skill}:${domain}:${entry.agent}`;
      const current = weights[key] ?? 0.5;    // default to neutral 0.5
      weights[key] = EMA_ALPHA * outcome + (1 - EMA_ALPHA) * current;
    }

    writeFileSync(this.weightsPath, JSON.stringify(weights, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
