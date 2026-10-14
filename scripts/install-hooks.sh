#!/usr/bin/env bash
# Install git hooks for agent-wire. Run once after cloning.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/usr/bin/env bash
# Pre-commit: run full test suite + type check before every commit.
# Fail the commit if either fails.
#
# Type check added 2026-09-29 — bun test alone let a missing `import { resolve }
# from "node:path"` ship past pre-commit into two CI failures (security.ts, see
# DEVLOG.md same date). bun test does not type-check; CI's separate
# `bunx tsc --noEmit` step is what actually caught it, after the push.
set -euo pipefail

echo "[pre-commit] running bun test..."
if ! bun test --bail --isolate; then
  echo "[pre-commit] BLOCKED — tests failed. Fix before committing."
  exit 1
fi
echo "[pre-commit] all tests passed."

echo "[pre-commit] running bunx tsc --noEmit..."
if ! bunx tsc --noEmit; then
  echo "[pre-commit] BLOCKED — type check failed. Fix before committing."
  exit 1
fi
echo "[pre-commit] type check passed."
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed pre-commit hook at $HOOKS_DIR/pre-commit"

cat > "$HOOKS_DIR/commit-msg" << 'EOF'
#!/usr/bin/env bash
# commit-msg: enforce conventional commit prefix.
# Valid: feat|fix|docs|test|refactor|chore|perf|build|ci: <subject>
MSG=$(cat "$1")
PATTERN='^(feat|fix|docs|test|refactor|chore|perf|build|ci)(\(.+\))?: .{1,120}$'

if ! echo "$MSG" | grep -qE "$PATTERN"; then
  echo "[commit-msg] BLOCKED — message must match: type(scope)?: subject"
  echo "  Valid types: feat fix docs test refactor chore perf build ci"
  echo "  Example: feat: add PhaseGate quality guardrail"
  echo "  Got: $MSG"
  exit 1
fi
EOF

chmod +x "$HOOKS_DIR/commit-msg"
echo "Installed commit-msg hook at $HOOKS_DIR/commit-msg"
