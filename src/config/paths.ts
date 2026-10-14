// Single source of truth for every path/URL constant the dispatch pipeline
// depends on. ISS-031: before this file existed, INBOX_DIR/STATE_DIR/
// KEYS_DIR/GATEWAY_URL were independently redefined in ~20 files with no
// shared reference — ISS-026 (the dispatch daemon watching a directory
// nothing wrote to for over a month) was one instance of this class of bug,
// not an isolated incident. Two more files (inbox-cmd.ts, diagnose-cmd.ts)
// were found already silently diverging in a subtler way (missing the
// process.env["HOME"] override every other copy checked).
//
// Every file that needs one of these constants MUST import it from here.
// Do not redefine INBOX_DIR/STATE_DIR/KEYS_DIR/PROJECT_ROOT/GATEWAY_URL
// locally — that reintroduces exactly the bug this file exists to prevent.

import { join } from "node:path";
import { homedir } from "node:os";

// Resolve project root as two levels up from src/config/
export const PROJECT_ROOT = join(import.meta.dir, "..", "..");

export const KEYS_DIR = process.env["WIRE_KEYS_DIR"] ?? join(PROJECT_ROOT, ".keys");
export const STATE_DIR = join(PROJECT_ROOT, ".wire-state");

export const INBOX_DIR = join(
  process.env["HOME"] ?? homedir(),
  "projects",
  "inbox"
);

export const GATEWAY_URL = process.env["WIRE_GATEWAY"] ?? "http://localhost:31338";
