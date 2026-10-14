// SkillRouter — consult skill outcome history before L1/L2 routing
//
// On a cache miss (skill not yet recorded or success_rate < threshold),
// returns null and the caller falls through to WireRouter.
// On a hit, returns the agent that worked best for this skill.

import { SkillRegistry } from "../skills/SkillRegistry.js";
import type { AgentId } from "../types.js";

const HIT_THRESHOLD = 0.7;  // success_rate required to trust skill history
const MIN_SAMPLES = 5;       // minimum records before we trust the stats

export class SkillRouter {
  private registry: SkillRegistry;

  constructor(stateDir: string) {
    this.registry = new SkillRegistry(stateDir);
  }

  // Returns best agent from history, or null (fall through to WireRouter).
  suggest(skill: string): AgentId | null {
    const stats = this.registry.stats(skill);
    if (!stats) return null;
    if (stats.total < MIN_SAMPLES) return null;
    if (stats.success_rate < HIT_THRESHOLD) return null;
    return (stats.most_used_agent as AgentId) ?? null;
  }
}
