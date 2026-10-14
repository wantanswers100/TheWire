#!/bin/bash
# Gemini adapter for WireProtocol v1
# Usage: gemini.sh <to> <skill> <payload_json>
#
# Prerequisites:
#   - Wire Gateway running: bun run wire-gateway (in agent-wire project)
#   - WIRE_TOKEN env var set to Gemini's gateway token (from bootstrap output)
#   - WIRE_GATEWAY env var set (default: http://localhost:31338)
#
# Example (from Gemini CLI session):
#   export WIRE_TOKEN=310912e8...
#   ./gemini.sh claude research '{"format":"task","verb":"query","domain":["python"],"output":{"format":"json"}}'

GATEWAY="${WIRE_GATEWAY:-http://localhost:31338}"
AGENT_ID="gemini"
TOKEN="${WIRE_TOKEN:-}"
TO="${1:-claude}"
SKILL="${2:-research}"
PAYLOAD="${3:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: WIRE_TOKEN not set. Export your gateway token:" >&2
  echo "  export WIRE_TOKEN=<gemini-token-from-bootstrap>" >&2
  exit 1
fi

if [ -z "$PAYLOAD" ]; then
  echo "Usage: gemini.sh <to> <skill> <payload_json>" >&2
  exit 1
fi

# Derive message type from skill
case "$SKILL" in
  implement|architect|scaffold|debug) TYPE="task" ;;
  research|plan|verify|explain)       TYPE="task" ;;
  *)                                  TYPE="task" ;;
esac

BODY=$(cat <<EOF
{
  "to": "$TO",
  "type": "$TYPE",
  "skill": "$SKILL",
  "payload": $PAYLOAD
}
EOF
)

echo "Sending WireProtocol v1 message: gemini → $TO (skill: $SKILL)" >&2

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$GATEWAY/send" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: $AGENT_ID" \
  -H "X-Agent-Token: $TOKEN" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_OUT=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "OK: $(echo "$BODY_OUT" | grep -o '"messageId":"[^"]*"')" >&2
  echo "$BODY_OUT"
else
  echo "ERROR $HTTP_CODE: $BODY_OUT" >&2
  exit 1
fi
