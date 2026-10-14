// extract-triples.ts — seed the knowledge graph from existing project docs
//
// Two extraction passes:
//   1. Rules-based — pulls structured facts (phase, status, test count) from STATUS.md + ISSUES.md
//   2. LLM-based   — sends context packs to Groq for semantic triple extraction
//
// Model: gemini-3.7-flash (free tier: 15 RPM, 32K output TPM)
//   Fallback: qwen2.5-coder:14b via Ollama (CPU-only, slow — last resort)
//   Note: Groq removed 2026-08-17 — all free-tier text models are reasoning models
//   that exhaust max_tokens on chain-of-thought before producing JSON output.
//
// Error handling:
//   - 401/403 from Groq aborts the entire batch immediately (not a transient error)
//   - All DB writes are transactional (no partial-write state)
//   - Exit code 1 if any project failed LLM extraction
//
// Usage:
//   bun run scripts/extract-triples.ts
//   bun run scripts/extract-triples.ts --dry-run    # print triples, don't write
//   bun run scripts/extract-triples.ts --show       # dump current triples.db

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_ROOT  = join(import.meta.dir, "..");
const PROJECTS_ROOT = join(homedir(), "projects");
const DB_PATH       = join(PROJECT_ROOT, ".wire-state", "triples.db");
const DRY_RUN       = process.argv.includes("--dry-run");
const SHOW_ONLY     = process.argv.includes("--show");

const ZONES: Array<{ dir: string; zone: string }> = [
  { dir: join(PROJECTS_ROOT, "active"),  zone: "active"  },
  { dir: join(PROJECTS_ROOT, "archive"), zone: "archive" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Triple {
  subject:    string;
  predicate:  string;
  object:     string;
  source:     string;
}

// ─── Env ──────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDb(): Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS triples (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      subject   TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object    TEXT NOT NULL,
      source    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (subject, predicate, object)
    );
    CREATE INDEX IF NOT EXISTS idx_subject   ON triples(subject);
    CREATE INDEX IF NOT EXISTS idx_predicate ON triples(predicate);
    CREATE INDEX IF NOT EXISTS idx_object    ON triples(object);

    CREATE TABLE IF NOT EXISTS triples_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function recordRun(db: Database, tripleCount: number): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const stmt = db.prepare("INSERT OR REPLACE INTO triples_meta (key, value) VALUES (?, ?)");
  stmt.run("last_run",    ts);
  stmt.run("last_count",  String(tripleCount));
  stmt.run("sprint",      "hybrid-rag-sprint1");
}

function insertTriples(db: Database, triples: Triple[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO triples (subject, predicate, object, source) VALUES (?, ?, ?, ?)"
  );
  // Wrap all inserts in a single transaction — prevents partial-write state on crash/kill
  const insertAll = db.transaction((rows: Triple[]) => {
    for (const t of rows) stmt.run(t.subject, t.predicate, t.object, t.source);
  });
  insertAll(triples);
}

// ─── Rules-based extraction ───────────────────────────────────────────────────

function extractFromStatus(project: string, filePath: string): Triple[] {
  const text = readFileSync(filePath, "utf8");
  const triples: Triple[] = [];
  const src = filePath.replace(homedir(), "~");

  // Word-boundary guard prevents matching inside words like "rephase"
  const phaseMatch = text.match(/\bphase\s+(\d+)\b/i);
  if (phaseMatch) {
    triples.push({ subject: project, predicate: "current_phase", object: `Phase ${phaseMatch[1]}`, source: src });
  }

  const testMatch = text.match(/(\d+)\/(\d+)\s+tests?\s+passing/i);
  if (testMatch) {
    triples.push({ subject: project, predicate: "test_count", object: `${testMatch[1]}/${testMatch[2]}`, source: src });
  }

  // Use else-if to avoid emitting contradictory status triples when STATUS.md
  // contains transition notes like "was ACTIVE, now PAUSED"
  if (/\bPAUSED\b/.test(text)) {
    triples.push({ subject: project, predicate: "status", object: "PAUSED", source: src });
  } else if (/\bCOMPLETE\b/.test(text)) {
    triples.push({ subject: project, predicate: "status", object: "COMPLETE", source: src });
  } else if (/\bACTIVE\b/.test(text)) {
    triples.push({ subject: project, predicate: "status", object: "ACTIVE", source: src });
  }

  const blockedMatches = text.matchAll(/blocked[_\s]on[:\s]+([A-Z]+-\d+)/gi);
  for (const m of blockedMatches) {
    // Guard the capture group rather than asserting it: an undefined object
    // would write a malformed triple into triples.db, and the knowledge graph
    // has no downstream validation to catch one. Surfaced once scripts/ was
    // added to tsconfig's include (Phase 50) — this file had never been
    // typechecked despite running the production graph extraction.
    const ref = m[1];
    if (!ref) continue;
    triples.push({ subject: project, predicate: "blocked_on", object: ref, source: src });
  }

  return triples;
}

function extractFromIssues(project: string, filePath: string): Triple[] {
  const text = readFileSync(filePath, "utf8");
  const triples: Triple[] = [];
  const src = filePath.replace(homedir(), "~");

  const seen = new Set<string>();
  for (const m of text.matchAll(/\b(ISS|DEC|RES)-(\d+)\b/g)) {
    const id = `${m[1]}-${m[2]}`;
    if (!seen.has(id)) {
      seen.add(id);
      triples.push({ subject: project, predicate: "has_issue", object: id, source: src });
    }
  }

  return triples;
}

// ─── LLM extraction ──────────────────────────────────────────────────────────
//
// Primary: Gemini 2.5 Flash (generativelanguage.googleapis.com) — native JSON mode
//   (responseMimeType: application/json), free tier: 15 RPM, 32K output TPM.
//   Not a reasoning model — outputs JSON directly, no think-block budget waste.
//
// Fallback: Ollama qwen2.5-coder:14b (CPU-only, 120s timeout).
//
// Groq was primary until 2026-08-17 (llama-3.3-70b-versatile removed).
// All remaining Groq free-tier text models (openai/gpt-oss-*, qwen/qwen3.6-27b)
// are reasoning models whose think blocks exhaust max_tokens before producing output.
// Groq removed from extraction pipeline until a non-reasoning model is available.
//
const GEMINI_EXTRACT_URL   = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent"; // 3.5/3.6 were 503 under high demand 2026-08-17; gemini-2.5-flash deprecated same day
const EXTRACT_MODEL_OLLAMA = "qwen2.5-coder:14b"; // fallback — no think blocks, JSON-capable

function buildExtractionPrompt(project: string, sections: string): string {
  return `You are a knowledge graph extractor. Extract factual relationships from the project documentation below.

Project name: "${project}"

Return ONLY a JSON object — no markdown fences, no explanation — with a single "triples" array. Each item has subject, predicate, object (all strings).

Rules:
- subject: the project name, a component name, or a named entity in the docs
- predicate: snake_case verb phrase (uses_stack, depends_on, provides, exposes, built_with, integrates_with, stores_in, routes_to, phase_complete, tracks_profile_of)
- object: the specific tool, project, component, model, API, or format
- Only extract explicitly stated facts — no inference
- Skip generic statements ("is a project", "has files", "is used")
- Max 20 triples

Example output format:
{"triples":[{"subject":"my-project","predicate":"uses_stack","object":"TypeScript"},{"subject":"my-project","predicate":"stores_in","object":"SQLite"}]}

Documentation:
${sections}`;
}


async function extractWithGemini(project: string, files: Record<string, string>, apiKey: string): Promise<Triple[]> {
  const sections = Object.entries(files)
    .map(([name, content]) => `## ${name}\n${content.slice(0, 1200)}`)
    .join("\n\n");
  const prompt = buildExtractionPrompt(project, sections);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_EXTRACT_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 2) {
        process.stdout.write(`  [gemini timeout] retrying...  `);
        await new Promise(r => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`Gemini timed out after 3 attempts: ${msg}`);
    }

    if (res.status === 503) {
      if (attempt < 2) {
        process.stdout.write(`  [gemini 503] retrying in 10s...  `);
        await new Promise(r => setTimeout(r, 10_000));
        continue;
      }
      throw new Error("Gemini 503 after 3 attempts (high demand)");
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "(unreadable)");
      throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 150)}`);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string; status?: string };
    };

    if (data.error) {
      if (data.error.status === "RESOURCE_EXHAUSTED") throw new Error("Gemini quota exhausted");
      throw new Error(`Gemini error: ${data.error.message}`);
    }

    // Strip markdown fences if present (Gemini sometimes wraps JSON in ```json ... ```)
    const rawFull = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const raw = rawFull.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed: Array<{ subject: string; predicate: string; object: string }>;
    try {
      const obj = JSON.parse(raw) as { triples?: typeof parsed } | typeof parsed;
      parsed = Array.isArray(obj) ? obj
             : (Array.isArray((obj as { triples?: typeof parsed }).triples)
                ? (obj as { triples: typeof parsed }).triples
                : []);
    } catch {
      const match = raw.match(/\{[\s\S]*"triples"[\s\S]*\}/) ?? raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error(`Gemini response not valid JSON (raw: ${raw.slice(0, 80)})`);
      const obj = JSON.parse(match[0]) as { triples?: typeof parsed } | typeof parsed;
      parsed = Array.isArray(obj) ? obj
             : (Array.isArray((obj as { triples?: typeof parsed }).triples)
                ? (obj as { triples: typeof parsed }).triples
                : []);
    }

    return parsed
      .filter(t => t.subject && t.predicate && t.object)
      .map(t => ({
        subject:   t.subject.trim(),
        predicate: t.predicate.trim().toLowerCase().replace(/[\s-]+/g, "_"),
        object:    t.object.trim(),
        source:    `llm:gemini/${project}`,
      }));
  }

  throw new Error("Gemini extraction failed after 3 attempts");
}

async function extractWithOllamaFallback(project: string, files: Record<string, string>): Promise<Triple[]> {
  const env       = { ...loadEnv(), ...process.env };
  const ollamaUrl = env["OLLAMA_URL"] ?? "http://localhost:11434";
  const sections  = Object.entries(files)
    .map(([name, content]) => `## ${name}\n${content.slice(0, 800)}`)
    .join("\n\n");

  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:   EXTRACT_MODEL_OLLAMA,
        prompt:  buildExtractionPrompt(project, sections),
        stream:  false,
        options: { temperature: 0, num_predict: 800 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Give a specific message for timeout vs connection refused
    if (msg.includes("timed out") || msg.includes("abort")) {
      throw new Error("Ollama timed out after 120s (CPU-only inference too slow for this input)");
    }
    throw new Error(`Ollama unavailable: ${msg}`);
  }

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

  let data: { response: string };
  try {
    data = await res.json() as { response: string };
  } catch (e) {
    // AbortSignal fired between headers and body completion
    throw new Error("Ollama response body truncated (timed out during read)");
  }

  const raw = (data.response ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  let parsed: Array<{ subject: string; predicate: string; object: string }> = [];
  try {
    const obj = JSON.parse(raw) as { triples?: typeof parsed } | typeof parsed;
    parsed = Array.isArray(obj) ? obj
           : (Array.isArray((obj as { triples?: typeof parsed }).triples)
              ? (obj as { triples: typeof parsed }).triples
              : []);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON in Ollama response");
    try { parsed = JSON.parse(match[0]); }
    catch { throw new Error("Malformed JSON in Ollama response"); }
  }

  return parsed
    .filter(t => t.subject && t.predicate && t.object)
    .map(t => ({
      subject:   t.subject.trim(),
      predicate: t.predicate.trim().toLowerCase().replace(/[\s-]+/g, "_"),
      object:    t.object.trim(),
      source:    `llm:ollama/${project}`,
    }));
}

// Returns triples and a flag indicating whether LLM extraction failed
async function extractLLM(
  project: string,
  files: Record<string, string>
): Promise<{ triples: Triple[]; failed: boolean }> {
  const env       = { ...loadEnv(), ...process.env };
  const geminiKey = env["GEMINI_API_KEY"];

  if (geminiKey && geminiKey !== "REPLACE_WITH_NEW_KEY_FROM_AI_STUDIO") {
    try {
      const triples = await extractWithGemini(project, files, geminiKey);
      return { triples, failed: false };
    } catch (e) {
      console.warn(`\n  [Gemini error] ${project}: ${e instanceof Error ? e.message : String(e)} — falling back to Ollama`);
    }
  }

  console.warn(`  [ollama fallback] ${project}: CPU-only (${EXTRACT_MODEL_OLLAMA}), may take 1-2 min`);
  try {
    const triples = await extractWithOllamaFallback(project, files);
    return { triples, failed: false };
  } catch (e) {
    console.warn(`  [LLM error] ${project}: ${e instanceof Error ? e.message : String(e)}`);
    return { triples: [], failed: true };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (SHOW_ONLY) {
    if (!existsSync(DB_PATH)) { console.log("No triples.db yet."); return; }
    const db   = new Database(DB_PATH, { readonly: true });
    try {
      const rows = db.query("SELECT subject, predicate, object, source FROM triples ORDER BY subject, predicate").all() as Triple[];
      console.log(`\n${rows.length} triples in ${DB_PATH}\n`);
      let lastSubj = "";
      for (const r of rows) {
        if (r.subject !== lastSubj) { console.log(`\n  [${r.subject}]`); lastSubj = r.subject; }
        console.log(`    ${r.predicate.padEnd(25)} → ${r.object}  ${r.source ? `(${r.source})` : ""}`);
      }
      console.log();
    } finally {
      db.close();
    }
    return;
  }

  if (DRY_RUN) console.log("DRY RUN — nothing will be written\n");

  const allTriples: Triple[] = [];
  let   llmFailCount = 0;

  // ── agent-wire self: docs/ folder ──────────────────────────────────────────
  console.log(`\n  [agent-wire] own docs/`);
  const docsDir = join(PROJECT_ROOT, "docs");
  if (existsSync(docsDir)) {
    const docFiles: Record<string, string> = {};
    for (const fname of ["ARCHITECTURE.md", "WIRESPEC.md", "PROTOCOL.md", "SECURITY.md", "ROADMAP.md"]) {
      const fp = join(docsDir, fname);
      if (existsSync(fp)) docFiles[fname] = readFileSync(fp, "utf8").slice(0, 1500);
    }
    if (Object.keys(docFiles).length > 0) {
      process.stdout.write(`    docs/ (${Object.keys(docFiles).join(", ")})  LLM extract...  `);
      const { triples: t, failed } = await extractLLM("agent-wire", docFiles);
      if (failed) llmFailCount++;
      console.log(`→ ${t.length} triples`);
      allTriples.push(...t);
    }
  }

  // ── All project zones ───────────────────────────────────────────────────────
  for (const { dir: zoneDir, zone } of ZONES) {
    if (!existsSync(zoneDir)) continue;
    const projects = readdirSync(zoneDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

    console.log(`\n── Zone: ${zone} (${projects.length} projects) ─────────────────────`);

    for (const project of projects) {
      console.log(`\n  ${project}  [${zone}]`);
      const projDir    = join(zoneDir, project);
      const contextDir = join(projDir, "context");

      allTriples.push({ subject: project, predicate: "zone", object: zone, source: `zones/${zone}` });

      const statusPath = join(projDir, "STATUS.md");
      if (existsSync(statusPath)) {
        const t = extractFromStatus(project, statusPath);
        console.log(`    STATUS.md       → ${t.length} triples`);
        allTriples.push(...t);
      }

      const issuesPath = join(projDir, "ISSUES.md");
      if (existsSync(issuesPath)) {
        const t = extractFromIssues(project, issuesPath);
        console.log(`    ISSUES.md       → ${t.length} triples`);
        allTriples.push(...t);
      }

      if (existsSync(contextDir)) {
        const packFiles: Record<string, string> = {};
        for (const fname of ["brief.md", "architecture.md", "surfaces.md"]) {
          const fp = join(contextDir, fname);
          if (existsSync(fp)) packFiles[fname] = readFileSync(fp, "utf8");
        }

        if (Object.keys(packFiles).length > 0) {
          process.stdout.write(`    LLM extract...  `);
          const { triples: t, failed } = await extractLLM(project, packFiles);
          if (failed) llmFailCount++;
          console.log(`→ ${t.length} triples`);
          allTriples.push(...t);
        } else {
          console.log(`    (no context pack)`);
        }
      } else {
        console.log(`    (no context/ dir)`);
      }
    }
  }

  console.log(`\n  Total: ${allTriples.length} triples extracted`);
  if (llmFailCount > 0) {
    console.warn(`  WARNING: ${llmFailCount} project(s) had LLM extraction failures (rules-based triples still written)`);
  }

  if (DRY_RUN) {
    console.log("\n── Preview (first 40) ──────────────────────────────────────");
    let lastSubj = "";
    for (const t of allTriples.slice(0, 40)) {
      if (t.subject !== lastSubj) { console.log(`\n  [${t.subject}]`); lastSubj = t.subject; }
      console.log(`    ${t.predicate.padEnd(25)} → ${t.object}`);
    }
    if (allTriples.length > 40) console.log(`\n  ... and ${allTriples.length - 40} more`);
    console.log();
    return;
  }

  const db = openDb();
  try {
    insertTriples(db, allTriples);
    recordRun(db, allTriples.length);

    const finalCount = (db.query("SELECT COUNT(*) as n FROM triples").get() as { n: number }).n;
    const meta       = db.query("SELECT key, value FROM triples_meta").all() as { key: string; value: string }[];
    console.log(`\n  Written to ${DB_PATH}`);
    console.log(`  ${finalCount} total triples in DB (deduped)`);
    for (const m of meta) console.log(`  ${m.key}: ${m.value}`);
    console.log("\n  Review with: bun run scripts/extract-triples.ts --show\n");
  } finally {
    db.close();
  }

  // Signal partial failure to the calling process (e.g., CI, cron)
  if (llmFailCount > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
