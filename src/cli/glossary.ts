// wire help terms — plain-language definitions of the words Wire, its docs and
// its release notes use. `wire help terms <word>` shows matching entries only.
// Keep entries short and jargon-free; add a term the first time it shows up in
// user-facing output or CHANGELOG.md.

interface Term {
  term: string;
  aka?: string[];       // extra words that should find this entry
  what: string;         // what it is
  why?: string;         // what it is for / why it runs
}

interface Section {
  title: string;
  terms: Term[];
}

export const GLOSSARY: Section[] = [
  {
    title: "USING WIRE",
    terms: [
      { term: "Dispatch", aka: ["NL dispatch", "wire -"], what: "Sending a task to an AI worker. `wire - <plain English>` classifies your words, picks a worker and sends it.", why: "So you never have to pick a model or write a structured command." },
      { term: "Classifier", aka: ["qwen3"], what: "A small local model (qwen3:4b, free) that reads your request and labels it: skill, verb, subject, confidence.", why: "The label decides which worker gets the task." },
      { term: "Confidence", what: "How sure the classifier is (0–100%). 85%+ sends without asking, 55–84% shows the plan and asks, below 55% stops and suggests `wire task`.", why: "Unclear requests get a human check before anything runs." },
      { term: "Worker", aka: ["agent"], what: "Whoever does the task: ollama (local), llama4/deepseek (Groq free tier), gemini, antigravity (agy), codex, claude, or system (your shell).", why: "Each is good at different things and costs different amounts." },
      { term: "Router", aka: ["fallback", "fallback chain"], what: "Picks the worker for a task and a backup order if it fails (quota, timeout, error).", why: "A task still gets done when one provider is down." },
      { term: "Provider policy", aka: ["free-first", "consent", "wire policy"], what: "The cost rules: free/local first, paid (claude, codex, gemini) only by explicit choice or as a last resort. `wire policy` shows them.", why: "Keeps routine work off paid APIs." },
      { term: "HITL", aka: ["human in the loop", "approval"], what: "Human-in-the-loop: Wire shows you the exact shell command (or escalated task) and waits for yes/no.", why: "Nothing consequential runs on your machine without you." },
      { term: "PhaseGate", aka: ["judge", "quality gate", "eval"], what: "After a worker answers, a local judge (qwen3:4b) checks the answer. A failed answer is retried; after 3 failures it is escalated to you (`wire dispatch review list`).", why: "Catches empty, off-topic or broken answers before you rely on them." },
      { term: "Escalation", what: "A task PhaseGate could not get a good answer for, parked for your decision.", why: "Bad output is surfaced, never silently delivered." },
      { term: "Dispatch daemon", aka: ["dispatch loop", "background"], what: "Background process that picks up queued tasks and runs them (`wire dispatch start|stop|status`).", why: "Tasks keep running after your terminal command returns." },
      { term: "Gateway", what: "Local HTTP service on 127.0.0.1:31338 that other programs use to talk to Wire.", why: "Lets tools on this machine (never the network) send and receive Wire messages." },
      { term: "MCP", aka: ["MCP server", "wire mcp"], what: "Model Context Protocol. `wire mcp` lets Claude Code, Codex or agy use Wire's 9 tools inside their own sessions.", why: "Use Wire from the AI CLI you are already in, not only the terminal." },
      { term: "Engaged", aka: ["wire engaged", "wire▸"], what: "Wire is working on something right now. `wire engaged` lists it; Claude Code's status line shows `wire▸ caller:action 12s` only while it runs.", why: "You can see Wire is busy (and for whom) without asking." },
      { term: "Context pack", aka: ["project-brief"], what: "Five short files per project (brief, architecture, surfaces, risks, deliverables) Wire hands to a worker.", why: "Workers get the project's facts without reading the whole repo." },
      { term: "WireProtocol v1", aka: ["protocol", "envelope"], what: "The format of Wire's message files (.wire.json). Its version changes only if that format changes.", why: "Not the release version — see Version." },
    ],
  },
  {
    title: "RELEASES AND UPDATES",
    terms: [
      { term: "Version", aka: ["release", "semver", "wire version"], what: "The release number X.Y.Z: patch (last) = fixes, minor (middle) = new commands/behaviour, major (first) = breaking changes. `wire version` shows it and checks for a newer one.", why: "One number per release makes it easy to see what you run and what changed (CHANGELOG.md)." },
      { term: "Update", aka: ["wire update"], what: "Moves your copy to the newest published release after asking. Only on a clean main, forward only, never deletes local work.", why: "Getting fixes is one command." },
      { term: "Local", aka: ["stage"], what: "Release stage 1: changes are made on a branch on the maintainer's machine; tests and type checks run on every commit.", why: "Answers: does it work?" },
      { term: "QA / UAT", aka: ["QA", "UAT", "stage"], what: "Release stage 2: the branch is pushed to the private repo, CI re-runs the tests, the review agents run, and the owner tries it for real.", why: "Answers: is it right? Nothing reaches users until the owner approves." },
      { term: "Production", aka: ["prod", "ship", "stage"], what: "Release stage 3: merged into main, version bumped, tagged vX.Y.Z, published to TheWire with the same tag.", why: "Answers: ship it. From here `wire version` tells users an update exists." },
      { term: "Branch / main", aka: ["branch", "main", "merge"], what: "A branch is a separate line of work; main is the released version. Merging brings a branch into main.", why: "Unfinished work never lands in what users run." },
      { term: "Tag", what: "A permanent label on one commit, e.g. v1.1.0.", why: "Marks exactly which code is a release; `wire update` moves to tags." },
      { term: "CI", aka: ["continuous integration", "GitHub Actions"], what: "GitHub re-runs the tests and type check on every push.", why: "A second, independent check that nothing broke." },
      { term: "TheWire", aka: ["public", "mirror"], what: "The public copy of Wire on GitHub (personal/noncommercial licence). Each release is mirrored there with the same version tag.", why: "Others can see, run and update Wire without access to the private working repo." },
    ],
  },
  {
    title: "REVIEW RUNS (before every release)",
    terms: [
      { term: "Review run", aka: ["review", "pre-merge", "gate"], what: "Four AI reviewers read only the changes in a release (the diff) before it can move from QA/UAT to production. Every finding is fixed or explicitly accepted by the owner.", why: "Tests prove code does what it was written to do; reviews catch what nobody wrote a test for — security holes, hidden failures, weak design." },
      { term: "Security reviewer", what: "An adversarial 'attacker's-eye' review of the changes — shell execution and HITL bypasses, secrets, file-path escapes, gateway/MCP exposure, unsafe defaults.", why: "Wire can run commands and write files on your machine; this review asks how a change could be abused before it ships." },
      { term: "Silent-failure hunter", aka: ["silent failure"], what: "Looks for errors that get swallowed: empty catch blocks, fallbacks that hide a failure, a 'pass' recorded when nothing was checked.", why: "The worst bugs don't crash — e.g. the quality judge that counted empty replies as passes (fixed in 1.1.0)." },
      { term: "Code reviewer", what: "Checks engineering quality and that the project's own rules are followed (Zod-only dependencies, HITL always on, 127.0.0.1-only services, DEVLOG entries).", why: "Keeps the codebase consistent and its promises true." },
      { term: "Type-design analyzer", aka: ["types"], what: "Checks that new data types make invalid states impossible and state their rules clearly.", why: "Good types stop whole classes of bugs before the code runs." },
    ],
  },
];

function matches(t: Term, q: string): boolean {
  const hay = [t.term, ...(t.aka ?? [])].map(s => s.toLowerCase());
  return hay.some(h => h.includes(q) || q.includes(h));
}

export function printGlossary(query?: string): void {
  const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const q = query?.trim().toLowerCase();
  const lines: string[] = [""];
  let found = 0;

  for (const section of GLOSSARY) {
    // A query that names the section ("review", "releases") shows the whole section.
    const hits = !q || section.title.toLowerCase().includes(q) ? section.terms : section.terms.filter(t => matches(t, q));
    if (hits.length === 0) continue;
    lines.push(b(section.title));
    for (const t of hits) {
      found++;
      lines.push(`  ${y(t.term)}`);
      lines.push(`    ${t.what}`);
      if (t.why) lines.push(`    ${d(`Why: ${t.why}`)}`);
    }
    lines.push("");
  }

  if (found === 0) {
    lines.push(`No term matches "${query}". Run: wire help terms`, "");
  } else if (!q) {
    lines.push(d("  One term: wire help terms <word>    e.g. wire help terms hitl"), "");
  }
  process.stdout.write(lines.join("\n"));
}
