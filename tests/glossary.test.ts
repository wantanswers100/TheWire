// wire help terms — every entry is complete, names are unique, and the words
// people actually type ("security", "uat", "review") find the right definitions.

import { describe, test, expect } from "bun:test";
import { GLOSSARY, printGlossary } from "../src/cli/glossary.js";

const all = GLOSSARY.flatMap(s => s.terms);

function capture(query?: string): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    printGlossary(query);
  } finally {
    process.stdout.write = orig;
  }
  return out.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("glossary", () => {
  test("every term has a name and a definition; names are unique", () => {
    for (const t of all) {
      expect(t.term.length).toBeGreaterThan(0);
      expect(t.what.length).toBeGreaterThan(20);
    }
    expect(new Set(all.map(t => t.term.toLowerCase())).size).toBe(all.length);
  });

  test("the four release reviewers are defined", () => {
    for (const name of ["Security reviewer", "Silent-failure hunter", "Code reviewer", "Type-design analyzer"]) {
      expect(all.some(t => t.term === name)).toBe(true);
    }
  });

  test("lookups find what people type", () => {
    expect(capture("security")).toContain("Security reviewer");
    expect(capture("uat")).toContain("QA / UAT");
    const review = capture("review");
    for (const name of ["Review run", "Security reviewer", "Silent-failure hunter", "Code reviewer", "Type-design analyzer"]) {
      expect(review).toContain(name);
    }
    expect(capture("banana")).toContain('No term matches "banana"');
  });
});
