// Router Layer 2 — Semantic Classifier
//
// Uses qwen3:4b (local, free) to classify a natural-language task description
// into structured RoutingRequest fields: skill, verb, domains.
//
// Called when Layer 1 rule matching produces a low-confidence result or the
// caller only has free-text (no structured skill/verb).
//
// LLM JSON output is not 100% reliable — strict validation + up to 3
// retries is mandatory (flagged as biggest risk in architecture review).

import { z } from "zod";
import { withOllamaLock } from "./ollamaGate.js";

const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
const CLASSIFIER_MODEL = "qwen3:4b";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 60_000;

// ─── Valid taxonomy ───────────────────────────────────────────────────────────

const KNOWN_SKILLS = [
  "implement", "refactor", "debug", "research", "scaffold", "summarize",
  "explain", "code_review", "verify", "audit", "quick", "wire", "system", "plan",
] as const;

const KNOWN_VERBS = [
  "implement", "debug", "refactor", "query", "plan", "scaffold",
  "summarize", "explain", "review", "verify", "audit", "classify", "execute",
] as const;

const KNOWN_DOMAINS = [
  "typescript", "bun", "node", "python", "react", "frontend",
  "backend", "api", "security", "crypto", "gcp", "firebase",
  "database", "local", "large-context", "general",
] as const;

// ─── Output schema ────────────────────────────────────────────────────────────

const ClassifierOutputSchema = z.object({
  skill: z.enum(KNOWN_SKILLS),
  verb: z.enum(KNOWN_VERBS),
  domains: z.array(z.enum(KNOWN_DOMAINS)).max(4),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200).optional(),
});

export type ClassifierResult = z.infer<typeof ClassifierOutputSchema>;

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(taskText: string): string {
  return `You are a task router classifier. Analyze the task and output ONLY valid JSON.

Task: "${taskText}"

Classify into this exact JSON structure:
{
  "skill": one of [${KNOWN_SKILLS.join(", ")}],
  "verb": one of [${KNOWN_VERBS.join(", ")}],
  "domains": array of 0-4 items from [${KNOWN_DOMAINS.join(", ")}],
  "confidence": float 0.0-1.0,
  "reasoning": "one sentence max"
}

Rules:
- skill = the primary capability needed
- verb = the action being performed
- domains = tech stack or topic areas relevant to the task
- confidence = how certain you are (0.9+ if clear, 0.5-0.8 if ambiguous)
- Output ONLY the JSON object, no markdown, no explanation outside it

JSON:`;
}

// ─── Ollama call ──────────────────────────────────────────────────────────────

interface OllamaGenerateResponse {
  response: string;
}

async function callPhi35(prompt: string): Promise<string> {
  return withOllamaLock(async () => {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        prompt,
        stream: false,
        think: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as OllamaGenerateResponse;
    return data.response?.trim() ?? "";
  });
}

// ─── JSON extraction ──────────────────────────────────────────────────────────
// LLM sometimes wraps output in markdown or adds trailing text

// Use bracket counting to extract the first complete {...} block.
// LLM often appends duplicate content or garbage after the valid object.
function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) return raw.trim();

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return raw.slice(start).trim();
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export async function classify(taskText: string): Promise<ClassifierResult | null> {
  if (!taskText.trim()) return null;

  const prompt = buildPrompt(taskText.slice(0, 1000)); // cap input length

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callPhi35(prompt);
      const jsonStr = extractJson(raw);
      const parsed = JSON.parse(jsonStr);
      const result = ClassifierOutputSchema.safeParse(parsed);

      if (result.success) return result.data;

      // On last attempt, log what we got for diagnostics
      if (attempt === MAX_RETRIES) {
        console.error(`[classifier] validation failed after ${MAX_RETRIES} attempts`);
        console.error(`[classifier] last raw output: ${raw.slice(0, 200)}`);
        console.error(`[classifier] zod error: ${result.error.message}`);
      }
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`[classifier] failed after ${MAX_RETRIES} attempts: ${e}`);
      }
    }
  }

  return null; // caller falls back to Layer 1 default or asks user
}

// ─── Availability check ───────────────────────────────────────────────────────

export async function isClassifierAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).some(m => m.name.startsWith("qwen3"));
  } catch {
    return false;
  }
}

// ─── Keyword fast-path (Tier 0 — no Ollama required) ─────────────────────────
//
// Instant regex-based classification. Runs before qwen3:4b and serves as the
// fallback when Ollama is unavailable or times out. Confidence is deliberately
// conservative (0.55–0.72) so results always show plan+confirm rather than
// silently dispatching.

function extractSubject(text: string): string {
  return text
    .replace(/^(please |can you |could you |i need |i want |help me |wire\s*-?\s*)/i, "")
    .replace(/^(what(?:'s| is| are| were) the? |what(?:'s| is| are) |how (?:is|are) the? |who is the? )/i, "")
    .trim()
    .slice(0, 80);
}

// ─── Linux intent detection ───────────────────────────────────────────────────
// Returns true if the text reads as a Linux system operation in plain English.
// Covers beginner ("show me my IP") through advanced ("list open sockets by pid").
// No --shell flag needed — detection is automatic.

export function isLinuxIntent(t: string): boolean {
  // ── System info & hardware ────────────────────────────────────────────────
  if (/\b(my ip( address)?|public ip|local ip|ip addr|ifconfig|hostname|uptime|kernel( version)?|os version|uname|cpu info|cpu model|processor|ram size|total memory|system info|hardware info|lshw|lscpu|lspci|lsusb|dmidecode)\b/.test(t)) return true;

  // ── Disk & storage ────────────────────────────────────────────────────────
  if (/\b(disk (usage|space|free|used)|storage (usage|space|free)|how much (disk|space|storage)|df |du |mount(ed| point|s)|unmount|fdisk|lsblk|partition(s|ed)?|filesystem|format (disk|drive)|block device)\b/.test(t)) return true;

  // ── Memory & CPU ─────────────────────────────────────────────────────────
  if (/\b(memory usage|ram usage|free memory|available memory|how much (memory|ram)|how much (free )?ram|swap (usage|space|file)|cpu usage|cpu load|load average|free -[mhg]|vmstat|iostat|sar |\bram\b.*\b(have|usage|used|free|total|size)\b)\b/.test(t)) return true;

  // ── Processes & jobs ─────────────────────────────────────────────────────
  if (/\b(running processes|list processes|what('s| is) running|kill (process|pid|job)|killall|pkill|htop|top |ps (aux|ef|a )|background jobs|foreground|job(s)? list|process id|pid of)\b/.test(t)) return true;

  // ── Services & systemd ────────────────────────────────────────────────────
  if (/\b(start|stop|restart|enable|disable|reload|status of) (service|daemon|unit|systemd|nginx|apache|ssh|sshd|mysql|postgres|redis|docker|cron|firewall)\b/.test(t)) return true;
  if (/\b(systemctl|service |journalctl|system logs|service logs|unit file|systemd)\b/.test(t)) return true;

  // ── Network ───────────────────────────────────────────────────────────────
  if (/\b(open ports|listening ports|network connections|active connections|netstat|ss -|ping |traceroute|tracepath|nslookup|dig |dns lookup|resolve|bandwidth|network speed|upload speed|download speed|network interfaces?|wifi|ethernet|ip route|routing table|arp table|mac address)\b/.test(t)) return true;

  // ── Firewall & security ───────────────────────────────────────────────────
  if (/\b(firewall (rules?|status|allow|block|deny)|ufw |iptables|nftables|block (ip|port|address)|allow (port|ip|address)|open port \d|close port \d|fail2ban|banned ip|ssh key|ssl cert|certificate|selinux|apparmor)\b/.test(t)) return true;

  // ── Files & directories ───────────────────────────────────────────────────
  if (/\b(list (files|dir|directory|folder)|show (files|dir|directory|folder)|what('s| is) in|find (file|directory|folder)|search (for )?file|locate file|where is (the )?file|file (size|permissions?|owner|type)|hidden files|symlink|hard link|inode|chmod|chown|chgrp|ls -|ll |la )\b/.test(t)) return true;

  // ── Text & search ─────────────────────────────────────────────────────────
  if (/\b(grep (for|in|through|all)|search (in|through|inside) (file|log|dir)|find text|look for text|count lines|word count|sort (file|output|lines)|unique lines|diff (file|between)|compare files|head of|tail of|last \d+ lines|first \d+ lines)\b/.test(t)) return true;

  // ── Packages & software ───────────────────────────────────────────────────
  if (/\b(install\b|uninstall\b|remove (package|app|software|program)|update (package|system|all packages)|upgrade (package|system)|list (installed|available) packages?|what packages?|apt (install|remove|update|upgrade|list|search|show)|apt-get|dpkg|snap (install|list|remove)|flatpak|pip install|npm (install|list)|yarn (add|list))\b/.test(t)) return true;

  // ── Users & permissions ───────────────────────────────────────────────────
  if (/\b(who(ami| is logged| is online)?|current user|add (user|group)|remove (user|group)|delete user|change password|passwd|sudo (access|rights|rules)|sudoers|user (list|info|groups)|group (list|members?)|logged (in|on) users?|last logins?|useradd|usermod|userdel|groupadd)\b/.test(t)) return true;

  // ── Logs ─────────────────────────────────────────────────────────────────
  if (/\b(system log|error log|auth log|syslog|dmesg|kern\.log|log file|last \d+ (lines|entries) of log|watch log|tail (the )?log|recent errors?|boot (log|messages?)|journal)\b/.test(t)) return true;

  // ── Archive & compression ─────────────────────────────────────────────────
  if (/\b(compress|extract|unzip|untar|tar (file|archive|ball)|zip (file|folder)|gzip|bzip2|archive (file|folder)|pack|unpack)\b/.test(t)) return true;

  // ── Environment & shell ───────────────────────────────────────────────────
  if (/\b(environment (variables?|vars?)|PATH variable|export |shell (config|profile|rc)|bash(rc|_profile)|zsh(rc)?|alias(es)?|current (shell|directory|path)|what shell|which shell|pwd|which |where is (the )?command|command not found)\b/.test(t)) return true;

  // ── Cron & scheduling ─────────────────────────────────────────────────────
  if (/\b(cron(tab)?( job| schedule| entry)?|scheduled (task|job)|at command|systemd timer|run (daily|weekly|hourly|at midnight|every \d+))\b/.test(t)) return true;

  // ── Docker & containers ───────────────────────────────────────────────────
  if (/\b(docker (ps|images?|run|stop|start|restart|logs?|exec|pull|push|build|rm|rmi|volume|network|compose)|list docker|docker containers?|container (list|status|logs?|stop|start|remove)|running containers?)\b/.test(t)) return true;

  // ── Git (system-level operations) ────────────────────────────────────────
  if (/\b(git (status|log|diff|branch|remote|pull|push|clone|init|add|commit|stash|reset|rebase|merge)|show (branches|commits|remotes|git log))\b/.test(t)) return true;

  // ── General system actions ────────────────────────────────────────────────
  if (/\b(reboot|shutdown|restart (the )?(system|machine|server|computer)|power off|hibernate|sleep mode|check (system|server) health|system (update|upgrade|maintenance))\b/.test(t)) return true;

  // ── Natural paraphrases — things people actually say ──────────────────────
  // These are close-enough variants that don't match the precise patterns above.
  if (/\b(what('s| is) (eating|using|hogging|taking|consuming|killing) (my )?(cpu|memory|ram|disk|bandwidth|network|space))\b/.test(t)) return true;
  if (/\b(anything (running|using|eating|hogging)|what('s| is) running|what processes?|what('s| is) (using|taking) up)\b/.test(t)) return true;
  if (/\b(am i (being )?(hacked|attacked|compromised)|who('s| is) (connected|accessing)|suspicious (connections?|traffic|logins?|activity))\b/.test(t)) return true;
  if (/\b(how (full|much space|much room)|almost (full|out of space)|running out of (space|disk|memory|ram))\b/.test(t)) return true;
  if (/\b(what('s| is) (listening|open|exposed)|any (open|exposed) (port|service))\b/.test(t)) return true;
  if (/\b(who (can|has|have) (access|sudo|root)|who('s| is) (an? )?(admin|root|sudoer))\b/.test(t)) return true;
  if (/\b(when (did|was) (it |the )?(system|server|machine) (last )?(boot|restart|reboot|start))\b/.test(t)) return true;
  if (/\b(slow(ing)? (down|my (system|machine|computer|server))|why is (my )?(system|computer|server|machine) slow)\b/.test(t)) return true;
  if (/\b(set up( a)?|configure|enable|turn on|turn off) (firewall|ufw|ssh|cron|swap|docker|nginx|apache)\b/.test(t)) return true;
  if (/\b(what version (of )?(linux|ubuntu|debian|kernel|bash|python|node|npm|bun|git|docker))\b/.test(t)) return true;
  if (/\b(how (long|many days?|many hours?) (has |have )?(the )?(system|server|machine|computer) been (up|running|online))\b/.test(t)) return true;

  return false;
}

// ─── OSINT / investigation intent detection ───────────────────────────────────
// Returns the detected target and type when the input reads as an OSINT request.
// Runs as a fast-path in exec.ts BEFORE the keyword classifier — no Ollama needed.

export type OsintTargetType = "domain" | "person" | "breach" | "network" | "social";

export interface OsintIntent {
  detected: boolean;
  target?:  string;
  type?:    OsintTargetType;
  tool?:    string;  // specific tool named (amass, sherlock, etc.)
}

// Named OSINT tools — if mentioned, it's definitely an OSINT request
const OSINT_TOOL_NAMES = /\b(amass|subfinder|theharvester|sherlock|maigret|h8mail|holehe|spiderfoot|maltego|recon-ng|photon|twint|instaloader|ghunt|exiftool|wafw00f|whatweb|nuclei|httpx|masscan|socialscan|phoneinfoga|metagoofil|waybackurls|gau)\b/i;

// Intent verbs that clearly signal OSINT
const OSINT_VERBS = /\b(investigate|osint|recon|reconnaissance|footprint|footprinting|dox|enumerate|harvest|scrape social|profile)\b/i;

// Specific queries that map to OSINT operations
const OSINT_PATTERNS: RegExp[] = [
  /\b(find|search|look up|get|gather|collect)\b.{0,20}\b(email(s)?|subdomains?|employees?|contacts?).{0,20}\b(from|for|of|at|on)\b/i,
  /\b(enumerate|scan)\b.{0,15}\b(subdomains?|ports?|services?|hosts?)\b/i,
  /\b(check|is|was)\b.{0,20}\b(email|address|password|credential|account)\b.{0,20}\b(breach|leak|hack|expos|compromis)\b/i,
  /\b(whois|who owns|who is behind|who registered|registrar of)\b/i,
  /\b(username|handle|account)\b.{0,20}\b(search|across|on|over|through)\b.{0,20}\b(platform|social|site|web)\b/i,
  /\b(social media|twitter|instagram|reddit|facebook)\b.{0,20}\b(search|profile|account|look up|find)\b/i,
  /\b(find|trace|track|locate)\b.{0,15}\b(ip|address|location|owner|person|individual)\b/i,
  /\b(dns|subdomain|certificate|cert)\b.{0,15}\b(lookup|search|enum|scan|find|list)\b/i,
  /\b(open|exposed)\b.{0,10}\b(port|service|endpoint)\b.{0,15}\b(on|for|at)\b/i,
  /\b(exif|metadata)\b.{0,20}\b(from|of|in|extract)\b/i,
  /\brun\b.{0,8}(amass|subfinder|theharvester|sherlock|maigret|h8mail|spiderfoot)\b/i,
];

// Extract target from common phrasings:
//   "investigate example.com"  → "example.com"
//   "osint on john_doe"        → "john_doe"
//   "enumerate subdomains of acme.com" → "acme.com"
//   "check if user@mail.com is breached" → "user@mail.com"
function extractOsintTarget(text: string): string | undefined {
  const t = text.trim();

  // "investigate <target>" / "osint <target>" / "recon <target>"
  let m = t.match(/\b(?:investigate|osint|recon|reconnaissance|dox|footprint)\s+(?:on\s+)?(\S+)/i);
  if (m?.[1]) return m[1].replace(/[.,;!?]+$/, "");

  // "run <tool> on <target>"
  m = t.match(/\brun\b.{0,12}(?:amass|subfinder|theharvester|sherlock|maigret|h8mail)\b.{0,8}(?:on|for|against)\s+(\S+)/i);
  if (m?.[1]) return m[1].replace(/[.,;!?]+$/, "");

  // "subdomains of <domain>"
  m = t.match(/\bsubdomains?\s+of\s+(\S+)/i);
  if (m?.[1]) return m[1].replace(/[.,;!?]+$/, "");

  // "whois <target>" / "who owns <target>"
  m = t.match(/\b(?:whois|who owns|who registered)\s+(\S+)/i);
  if (m?.[1]) return m[1].replace(/[.,;!?]+$/, "");

  // "check if <email>"
  m = t.match(/\bcheck\b.{0,10}\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/i);
  if (m?.[1]) return m[1];

  // Standalone email anywhere in the text
  m = t.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
  if (m?.[1]) return m[1];

  // "ports on <ip>" / "scan <ip>"
  m = t.match(/\b(?:ports?\s+on|scan)\s+([\d.]+(?:\/\d+)?)/i);
  if (m?.[1]) return m[1];

  // "on/for/about/against <domain.tld>"
  m = t.match(/\b(?:on|for|about|against|of)\s+([a-zA-Z0-9][-a-zA-Z0-9]{0,61}[a-zA-Z0-9]\.[a-zA-Z]{2,})/i);
  if (m?.[1]) return m[1];

  // Bare domain in input
  m = t.match(/\b([a-zA-Z0-9][-a-zA-Z0-9]{0,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2})?)\b/);
  if (m?.[1]) return m[1];

  // Bare username at end of sentence
  m = t.match(/\b([a-zA-Z0-9_.-]{3,30})\s*$/i);
  if (m?.[1] && !["me", "it", "up", "on", "in", "at", "of", "is", "was", "the", "and"].includes(m[1].toLowerCase())) {
    return m[1];
  }

  return undefined;
}

function detectOsintType(target: string | undefined): OsintTargetType {
  if (!target) return "domain";
  if (/^[\d.]+$/.test(target) || /^[0-9a-f:]+\/?\d*$/i.test(target)) return "network";
  if (/@/.test(target)) return "breach";
  if (/\+?\d[\d\s\-().]{7,}/.test(target)) return "person";
  if (/\.[a-z]{2,}$/.test(target)) return "domain";
  return "person"; // bare username → person/social
}

export function isOsintIntent(text: string): OsintIntent {
  const t = text.toLowerCase();

  // Explicit tool name → definite OSINT
  if (OSINT_TOOL_NAMES.test(t)) {
    const target = extractOsintTarget(text);
    const tool   = (text.match(OSINT_TOOL_NAMES)?.[0] ?? "").toLowerCase();
    return { detected: true, target, type: detectOsintType(target), tool };
  }

  // OSINT verb → definite OSINT
  if (OSINT_VERBS.test(t)) {
    const target = extractOsintTarget(text);
    return { detected: true, target, type: detectOsintType(target) };
  }

  // Pattern matches → OSINT
  for (const pattern of OSINT_PATTERNS) {
    if (pattern.test(t)) {
      const target = extractOsintTarget(text);
      return { detected: true, target, type: detectOsintType(target) };
    }
  }

  return { detected: false };
}

export function keywordClassify(taskText: string): ClassifierExtendedResult {
  const t = taskText.toLowerCase();

  // ISS-028: every branch below must return a non-empty `domains` array.
  // WireSpec's schema requires at least one domain entry; a branch that
  // returns `[]` produces a payload guaranteed to fail schema validation,
  // which processFile() then discards silently (see ISS-028's companion fix
  // in loop.ts). This is the fallback path used when the qwen3:4b classifier
  // is unavailable or times out — i.e. exactly the scenario this function
  // exists for — so every branch matters, not just the common ones.
  // "general" is a real domain elsewhere in the codebase (task-cmd.ts's
  // default `--domain` flag value), so it's a safe, meaningful default here.

  // Linux/system intent — checked first, covers beginner to advanced operations
  if (isLinuxIntent(t))
    return { skill: "system", verb: "execute", domains: ["local"], subject: extractSubject(taskText), confidence: 0.75 };

  // Code/debug patterns first — most specific
  if (/\b(debug|fix the|fix a|error|bug|crash|exception|traceback|failing|broken)\b/.test(t))
    return { skill: "debug",       verb: "debug",     domains: ["general"], subject: extractSubject(taskText), confidence: 0.72 };
  if (/\b(summarize|summary|recap|tldr|tl;dr)\b/.test(t))
    return { skill: "quick",       verb: "summarize", domains: ["general"], subject: extractSubject(taskText), confidence: 0.72 };
  if (/\b(implement|build|create|scaffold|generate|write code)\b/.test(t))
    return { skill: "implement",   verb: "implement", domains: ["general"], subject: extractSubject(taskText), confidence: 0.70 };
  if (/\b(refactor|clean up|improve|optimize|restructure)\b/.test(t))
    return { skill: "refactor",    verb: "refactor",  domains: ["general"], subject: extractSubject(taskText), confidence: 0.70 };
  if (/\b(review|audit|inspect)\b/.test(t))
    return { skill: "code_review", verb: "review",    domains: ["general"], subject: extractSubject(taskText), confidence: 0.65 };
  if (/\b(plan|design|architect|outline|roadmap)\b/.test(t))
    return { skill: "plan",        verb: "plan",      domains: ["general"], subject: extractSubject(taskText), confidence: 0.65 };

  // Live/factual queries before generic explain — "what is the temp" is research, not explain
  if (/\b(news|current|latest|today|weather|temp|temperature|price|stock|forecast)\b/.test(t))
    return { skill: "research",    verb: "query",     domains: ["general"], subject: extractSubject(taskText), confidence: 0.68 };
  if (/\b(research|find|look up|search|who is|where is|when (is|was|did))\b/.test(t))
    return { skill: "research",    verb: "query",     domains: ["general"], subject: extractSubject(taskText), confidence: 0.65 };

  // Generic explain — "what is X", "how does X work", "why does X"
  if (/\b(explain|what (is|are|does|do)\b|how (does|do|to)\b|why (is|are|does)\b)/i.test(t))
    return { skill: "explain",     verb: "explain",   domains: ["general"], subject: extractSubject(taskText), confidence: 0.62 };

  // Default — lowest confidence, always prompts
  return { skill: "research",    verb: "query",     domains: ["general"], subject: extractSubject(taskText), confidence: 0.55 };
}

// ─── Extended classifier (for NL dispatch) ────────────────────────────────────
//
// Adds `subject` (verbatim span from input) and optional `preferredAgent` to
// the classification schema. Uses a tiered retry strategy and sessions-scoped
// result caching to avoid redundant inference.

const ExtendedClassifierOutputSchema = z.object({
  skill: z.enum(KNOWN_SKILLS),
  verb: z.enum(KNOWN_VERBS),
  domains: z.array(z.enum(KNOWN_DOMAINS)).max(4),
  subject: z.string().max(80).optional(),
  preferredAgent: z.enum(["claude", "gemini", "codex", "ollama"]).optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200).optional(),
  decomposition: z.object({
    type: z.enum(["functional", "temporal", "spatial", "resource"]),
    reason: z.string(),
  }).optional(),
});

export type ClassifierExtendedResult = z.infer<typeof ExtendedClassifierOutputSchema>;

const MinimalClassifierOutputSchema = z.object({
  skill: z.enum(KNOWN_SKILLS),
  verb: z.enum(KNOWN_VERBS),
  confidence: z.number().min(0).max(1),
});

function buildExtendedPrompt(taskText: string, repairNote = ""): string {
  // Static instructions + examples first, the task (and any repair note) last:
  // Ollama reuses its KV cache for a shared prompt prefix, so this ~750-token
  // block is prefilled once per model load instead of once per task. With the
  // task near the top, every classification re-prefilled it — ~35s on this
  // CPU, which with generation exceeded the 45s timeout (DEVLOG 2026-09-30).
  const staticPart = `You are a task router classifier. Analyze the task at the end and output ONLY valid JSON.

Classify into this exact JSON structure:
{
  "skill": one of [${KNOWN_SKILLS.join(", ")}],
  "verb": one of [${KNOWN_VERBS.join(", ")}],
  "domains": array of 0-4 items from [${KNOWN_DOMAINS.join(", ")}],
  "subject": "the specific thing being acted on",
  "preferredAgent": one of [claude, gemini, codex, ollama] or omit this field entirely,
  "confidence": float 0.0-1.0,
  "reasoning": "one sentence max",
  "decomposition": {"type": "<type>", "reason": "<one sentence>"}
}

Rules:
- skill = the primary capability needed
- verb = the action being performed
- domains = tech stack or topic areas relevant to the task
- subject = copy the specific object verbatim from the task text (e.g. "auth middleware", "UK housing policy", "standup notes") — 2-6 words, noun phrase only, do NOT paraphrase
- preferredAgent = ONLY set if user explicitly named an agent ("use Gemini" → gemini, "run locally" → ollama, "ask Codex" → codex). Otherwise omit this field entirely.
- confidence = how certain you are (0.9+ if clear, 0.5-0.8 if ambiguous)
- decomposition type: functional (single skill domain, route directly), temporal (ordered steps where step N+1 depends on step N output), spatial (independent parallel scopes, can run concurrently), resource (start with cheapest model, escalate only on failure)
- Output ONLY the JSON object, no markdown, no explanation outside it

Examples:

Task: "fix the TypeError in src/router/classifier.ts line 42"
{"skill":"debug","verb":"debug","domains":["typescript"],"subject":"TypeError in classifier.ts","confidence":0.95,"reasoning":"Explicit error type and file path indicate debugging."}

Task: "research UK housing policy trends for a policy brief"
{"skill":"research","verb":"query","domains":[],"subject":"UK housing policy trends","confidence":0.92,"reasoning":"Research task with no code domain, policy topic."}

Task: "summarize today's standup notes using Gemini"
{"skill":"summarize","verb":"summarize","domains":[],"subject":"standup notes","preferredAgent":"gemini","confidence":0.97,"reasoning":"Explicit summarize verb, Gemini named."}

Task: "show me my IP address"
{"skill":"system","verb":"execute","domains":["local"],"subject":"IP address","confidence":0.95,"reasoning":"Linux system query, no code involved."}

Task: "install nginx and check if it's running"
{"skill":"system","verb":"execute","domains":["local"],"subject":"nginx install and status","confidence":0.95,"reasoning":"Package install and service check — system operation."}

Task: "what is eating my disk space"
{"skill":"system","verb":"execute","domains":["local"],"subject":"disk space usage","confidence":0.93,"reasoning":"System resource query."}

`;
  return `${staticPart}${repairNote}Task: "${taskText}"
JSON:`;
}

function buildMinimalPrompt(taskText: string): string {
  return `Classify this task. Output ONLY valid JSON with exactly three fields.

Task: "${taskText}"

{
  "skill": one of [${KNOWN_SKILLS.join(", ")}],
  "verb": one of [${KNOWN_VERBS.join(", ")}],
  "confidence": float 0.0-1.0
}

JSON:`;
}

// Ollama structured output schemas (requires Ollama ≥0.30.8).
// Passed as `format` in the request body. Falls back to format:"json" on 400
// so older Ollama versions keep working — Zod validation still runs on the result.
const EXTENDED_OLLAMA_SCHEMA = {
  type: "object",
  properties: {
    skill:          { type: "string", enum: [...KNOWN_SKILLS] },
    verb:           { type: "string", enum: [...KNOWN_VERBS] },
    domains:        { type: "array", items: { type: "string", enum: [...KNOWN_DOMAINS] }, maxItems: 4 },
    subject:        { type: "string", maxLength: 80 },
    preferredAgent: { type: "string", enum: ["claude", "gemini", "codex", "ollama"] },
    confidence:     { type: "number", minimum: 0, maximum: 1 },
    reasoning:      { type: "string", maxLength: 200 },
    decomposition:  {
      type: "object",
      properties: {
        type:   { type: "string", enum: ["functional", "temporal", "spatial", "resource"] },
        reason: { type: "string" },
      },
    },
  },
  required: ["skill", "verb", "domains", "confidence"],
};

const MINIMAL_OLLAMA_SCHEMA = {
  type: "object",
  properties: {
    skill:      { type: "string", enum: [...KNOWN_SKILLS] },
    verb:       { type: "string", enum: [...KNOWN_VERBS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["skill", "verb", "confidence"],
};

async function callModel(
  model: string,
  prompt: string,
  numPredict: number,
  timeoutMs: number,
  schema?: object,
): Promise<string> {
  return withOllamaLock(async () => {
    const baseBody = {
      model,
      prompt,
      stream: false,
      // The installed Ollama (0.18.2) puts qwen3 output into `thinking` and can
      // leave `response` empty unless thinking is disabled per request — the
      // `/no_think` prompt suffix is not honored. Empty `response` →
      // JSON.parse("") → "Unexpected EOF",
      // two 4b attempts wasted, then the 1.7b tier misroutes (DEVLOG 2026-09-30).
      think: false,
      format: (schema ?? "json") as object | string,
      options: { temperature: 0.1, num_predict: numPredict },
    };

    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Ollama <0.30.8 returns 400 on structured schema format — retry with plain "json"
    if (!res.ok && res.status === 400 && schema) {
      const fallbackRes = await fetch(`${OLLAMA}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, format: "json" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!fallbackRes.ok) throw new Error(`Ollama ${fallbackRes.status}: ${fallbackRes.statusText}`);
      const fallbackData = await fallbackRes.json() as OllamaGenerateResponse;
      return fallbackData.response?.trim() ?? "";
    }

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
    const data = await res.json() as OllamaGenerateResponse;
    return data.response?.trim() ?? "";
  });
}

// Session-scoped cache — avoids re-classifying the same input within a process run.
// Key: trimmed lowercased task text. TTL: process lifetime (no eviction needed).
const _extendedCache = new Map<string, ClassifierExtendedResult>();

export async function classifyExtended(taskText: string): Promise<ClassifierExtendedResult | null> {
  const text = taskText.trim().slice(0, 1000);
  if (!text) return null;

  const cacheKey = text.toLowerCase();
  const cached = _extendedCache.get(cacheKey);
  if (cached) return cached;

  const REPAIR_NOTE =
    "Previous attempt failed JSON validation. Output ONLY the JSON object, starting with { and ending with }.\n\n";

  // Attempts 1 & 2: qwen3:4b, extended schema.
  // Attempt 1 gets 90s: after a model load it must prefill the ~750-token
  // static prompt prefix once (measured ~35s prefill + ~10s generation on this
  // CPU, 2026-09-30). Attempt 2 (repair) reuses that cached prefix, so 30s is
  // ample. A timeout on attempt 1 skips straight to the 1.7b tier — retrying a
  // timed-out 4b only doubled the wait (95s in the 2026-09-30 transcript).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildExtendedPrompt(text, attempt === 2 ? REPAIR_NOTE : "");
    try {
      const raw = await callModel("qwen3:4b", prompt, 300, attempt === 1 ? 90_000 : 30_000, EXTENDED_OLLAMA_SCHEMA);
      const jsonStr = extractJson(raw);
      const parsed = JSON.parse(jsonStr);
      const result = ExtendedClassifierOutputSchema.safeParse(parsed);
      if (result.success) {
        _extendedCache.set(cacheKey, result.data);
        return result.data;
      }
      if (attempt === 2) {
        console.warn(`[classifier] extended schema validation failed (attempt 2): ${result.error.message.slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`[classifier] qwen3:4b error (attempt ${attempt}): ${e}`);
      if (e instanceof Error && e.name === "TimeoutError") break;
    }
  }

  // Attempt 3: qwen3:1.7b, minimal schema (no subject/preferredAgent)
  try {
    const raw = await callModel("qwen3:1.7b", buildMinimalPrompt(text), 128, 20_000, MINIMAL_OLLAMA_SCHEMA);
    const jsonStr = extractJson(raw);
    const parsed = JSON.parse(jsonStr);
    const result = MinimalClassifierOutputSchema.safeParse(parsed);
    if (result.success) {
      // ISS-028: MINIMAL_OLLAMA_SCHEMA never asks the model for domains, so
      // this always used to be []. WireSpec's schema requires at least one
      // domain entry — an empty array here produced a payload guaranteed to
      // fail schema validation, silently discarded by processFile() with no
      // trace. This is the qwen3:1.7b fallback tier (attempt 3, after both
      // qwen3:4b attempts failed) — exactly the degraded-mode path where a
      // silent drop is least acceptable.
      const fallback: ClassifierExtendedResult = {
        skill: result.data.skill,
        verb: result.data.verb,
        domains: ["general"],
        // Capped below the 0.85 silent-dispatch gate: silent dispatch is a
        // qwen3:4b-only contract (nl-cmd.ts). This degraded tier reported 0.95
        // for "weather in 75001" → audit/classify and sent it to Claude
        // unprompted (DEVLOG 2026-09-30); it must always show plan + confirm.
        confidence: Math.min(result.data.confidence, 0.84),
        // subject intentionally absent — caller uses raw task text as fallback
      };
      _extendedCache.set(cacheKey, fallback);
      return fallback;
    }
    console.warn(`[classifier] qwen3:1.7b minimal schema also failed`);
  } catch (e) {
    console.warn(`[classifier] qwen3:1.7b error: ${e}`);
  }

  console.error(`[classifier] classifyExtended failed after 3 attempts for: "${text.slice(0, 60)}"`);
  return null;
}
