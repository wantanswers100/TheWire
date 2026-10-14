// wire modelupdate — Ollama model status + upgrade suggestions
//
// Usage:
//   wire modelupdate           show status only (no pulls)
//   wire modelupdate --yes     pull all installed Wire models
//   wire modelupdate --install install missing Wire models

import { OLLAMA_URL, OLLAMA_SKILL_MODEL, EMBED_MODEL } from "../config/models.js";

const ok   = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red  = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ─── Curated upgrade map ──────────────────────────────────────────────────────
// Known model successions — keeps this list current with Ollama's library.
// Format: installed base → { to: successor, reason, breaking: whether it's a drop-in }

const KNOWN_UPGRADES: Record<string, { to: string; reason: string; dropIn: boolean }> = {
  "llama2":          { to: "llama3.2",          reason: "generation leap in reasoning",         dropIn: false },
  "llama3":          { to: "llama3.2",           reason: "latest Llama 3.x release",             dropIn: true  },
  "llama3.1":        { to: "llama3.2",           reason: "latest Llama 3.x release",             dropIn: true  },
  "phi3":            { to: "phi4",               reason: "Microsoft's latest — better math+code", dropIn: true  },
  "phi3.5":          { to: "phi4",               reason: "Microsoft's latest — better math+code", dropIn: true  },
  "mistral":         { to: "mistral-nemo",       reason: "current Mistral release (12B)",         dropIn: true  },
  "mistral:7b":      { to: "mistral-nemo",       reason: "current Mistral release (12B)",         dropIn: false },
  "deepseek-coder":  { to: "qwen2.5-coder:14b",  reason: "outperforms on local code tasks",       dropIn: false },
  "codellama":       { to: "qwen2.5-coder:14b",  reason: "qwen2.5-coder is the current best",    dropIn: false },
  "gemma":           { to: "gemma2",             reason: "Gemma 2 — significantly improved",      dropIn: true  },
  "gemma2":          { to: "gemma3",             reason: "Gemma 3 — best in class at size",       dropIn: true  },
  "qwen2":           { to: "qwen3",              reason: "Qwen3 — reasoning + 32K context",       dropIn: true  },
  "qwen2.5":         { to: "qwen3",              reason: "Qwen3 — reasoning + 32K context",       dropIn: true  },
  "deepseek-r1:7b":  { to: "deepseek-r1:8b",    reason: "q8 quantization — better output quality", dropIn: true },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function baseModel(name: string): string {
  return name.split(":")[0] ?? name;
}

interface InstalledModel {
  name:        string;
  size:        number;
  modifiedAt?: string;
}

async function getInstalled(): Promise<InstalledModel[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at?: string }> };
  return (data.models ?? []).map(m => ({
    name:       m.name,
    size:       m.size,
    modifiedAt: m.modified_at,
  }));
}

async function pullModel(name: string): Promise<void> {
  process.stdout.write(`  pulling ${cyan(name)}...\n`);

  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ name, stream: true }),
    signal:  AbortSignal.timeout(600_000),
  });

  if (!res.ok || !res.body) {
    process.stdout.write(`  ${warn("failed")} HTTP ${res.status}\n`);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let lastStatus = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = dec.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as { status?: string; completed?: number; total?: number };
        const st = ev.status ?? "";
        // Only reprint on meaningful status changes
        if (st !== lastStatus && !st.startsWith("pulling ")) {
          process.stdout.write(`    ${dim(st)}\n`);
          lastStatus = st;
        } else if (st === "success") {
          process.stdout.write(`  ${ok("✓")} ${name} — up to date or updated\n`);
        }
      } catch { /* ignore parse errors */ }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runModelUpdate(args: string[]): Promise<void> {
  const doYes     = args.includes("--yes");
  const doInstall = args.includes("--install");

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${bold("Wire Model Update")}  ${dim(ts)}`);
  console.log(dim("─".repeat(60)));

  // ── Fetch installed models ────────────────────────────────────────────────

  let installed: InstalledModel[] = [];
  try {
    installed = await getInstalled();
  } catch (e) {
    console.log(`\n${warn("Ollama offline")} — ${e instanceof Error ? e.message : String(e)}`);
    console.log(dim("  Start Ollama: ollama serve"));
    return;
  }

  const installedNames = new Set(installed.map(m => m.name));
  const installedBases = new Set(installed.map(m => baseModel(m.name)));

  // ── Wire skill → model matrix ─────────────────────────────────────────────

  // Unique Wire models (deduplicated)
  const wireModels = new Set<string>([
    ...Object.values(OLLAMA_SKILL_MODEL),
    EMBED_MODEL,
  ]);

  console.log(bold("\nInstalled models"));

  for (const m of installed) {
    const wireSkills = Object.entries(OLLAMA_SKILL_MODEL)
      .filter(([, model]) => model === m.name || model === baseModel(m.name))
      .map(([skill]) => skill);
    const isEmbed = m.name === EMBED_MODEL || baseModel(m.name) === EMBED_MODEL;
    if (isEmbed) wireSkills.push("embed");

    const skillsLabel = wireSkills.length > 0 ? dim(`  [${wireSkills.join(", ")}]`) : "";
    console.log(`  ${ok("✓")}  ${m.name.padEnd(28)} ${fmtSize(m.size).padEnd(10)}${skillsLabel}`);
  }

  // ── Missing Wire models ───────────────────────────────────────────────────

  const missing: string[] = [];
  for (const model of wireModels) {
    const base = baseModel(model);
    if (!installedNames.has(model) && !installedBases.has(base)) {
      missing.push(model);
    }
  }

  if (missing.length > 0) {
    console.log(bold("\nMissing Wire models"));
    for (const m of missing) {
      const skills = Object.entries(OLLAMA_SKILL_MODEL)
        .filter(([, v]) => v === m)
        .map(([k]) => k);
      const skillsLabel = skills.length > 0 ? dim(`  [${skills.join(", ")}]`) : "";
      console.log(`  ${warn("○")}  ${m.padEnd(28)}${skillsLabel}`);
    }
    if (doInstall) {
      console.log();
      for (const m of missing) {
        await pullModel(m);
      }
    } else {
      console.log(dim("\n  Install: wire modelupdate --install"));
    }
  }

  // ── Upgrade suggestions ───────────────────────────────────────────────────

  const suggestions: Array<{ from: string; to: string; reason: string; dropIn: boolean }> = [];
  for (const m of installed) {
    const base = baseModel(m.name);
    const upgrade = KNOWN_UPGRADES[m.name] ?? KNOWN_UPGRADES[base];
    if (upgrade && !installedBases.has(baseModel(upgrade.to))) {
      suggestions.push({ from: m.name, ...upgrade });
    }
  }

  if (suggestions.length > 0) {
    console.log(bold("\nUpgrade suggestions"));
    for (const s of suggestions) {
      const compat = s.dropIn ? ok("drop-in") : warn("config change needed");
      console.log(`  ${warn("→")}  ${s.from.padEnd(26)} → ${cyan(s.to)}`);
      console.log(`     ${dim(s.reason)}  ${dim("·")}  ${compat}`);
    }
    console.log(dim("\n  Install a suggested model: ollama pull <name>"));
  }

  // ── VPN + model compatibility note ───────────────────────────────────────

  console.log(bold("\nModel + VPN compatibility"));
  console.log(`  ${ok("✓")}  Ollama (local)       unaffected — never leaves localhost`);
  console.log(`  ${ok("✓")}  Gemini API           API-key auth, works over any VPN`);
  console.log(`  ${ok("✓")}  Anthropic API        API-key auth, works over any VPN`);
  console.log(dim("  Note: some VPN exit IPs appear on cloud blocklists — use Mullvad or ProtonVPN"));

  // ── Pull installed models ─────────────────────────────────────────────────

  if (doYes) {
    console.log(bold("\nPulling updates for all installed Wire models"));
    const toPull = installed.filter(m => {
      const base = baseModel(m.name);
      return wireModels.has(m.name) || wireModels.has(base) || m.name === EMBED_MODEL;
    });

    if (toPull.length === 0) {
      console.log(dim("  Nothing to pull."));
    } else {
      for (const m of toPull) {
        await pullModel(m.name);
      }
    }
    console.log();
  } else {
    console.log(dim(`\n  To pull updates: wire modelupdate --yes`));
    console.log(dim("  (Ollama auto-updates — pulls are skipped if already current)"));
  }

  console.log();
}
