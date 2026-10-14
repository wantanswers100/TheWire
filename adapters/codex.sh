#!/bin/bash
# Codex adapter for WireProtocol v1
# Identical pattern to gemini.sh — Codex uses the same gateway.
# Usage: codex.sh <to> <skill> <payload_json>
#
# Prerequisites:
#   - Wire Gateway running: bun run wire-gateway
#   - WIRE_TOKEN set to Codex's gateway token
#
# Example:
#   export WIRE_TOKEN=78bb2549...
#   ./codex.sh claude scaffold '{"format":"task","verb":"implement","domain":["typescript"],"output":{"format":"code","language":"typescript"}}'

GATEWAY="${WIRE_GATEWAY:-http://localhost:31338}"
AGENT_ID="codex"
TOKEN="${WIRE_TOKEN:-}"
TO="${1:-claude}"
SKILL="${2:-scaffold}"
PAYLOAD="${3:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: WIRE_TOKEN not set." >&2
  exit 1
fi

if [ -z "$PAYLOAD" ]; then
  echo "Usage: codex.sh <to> <skill> <payload_json>" >&2
  exit 1
fi

BODY=$(printf '{"to":"%s","type":"task","skill":"%s","payload":%s}' "$TO" "$SKILL" "$PAYLOAD")

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$GATEWAY/send" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: $AGENT_ID" \
  -H "X-Agent-Token: $TOKEN" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_OUT=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "$BODY_OUT"
else
  echo "ERROR $HTTP_CODE: $BODY_OUT" >&2
  exit 1
fi
