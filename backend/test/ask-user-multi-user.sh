#!/usr/bin/env bash
# E2E regression test for ask_user multi-user behavior (T-110).
#
# Requires a running DevGrimoire stack with auth enabled.
#
# Usage:
#   API_BASE=http://localhost:3200/api \
#   AUTH_USERNAME=admin AUTH_PASSWORD=admin123 \
#   bash backend/test/ask-user-multi-user.sh

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
ADMIN_USER="${AUTH_USERNAME:-admin}"
ADMIN_PASS="${AUTH_PASSWORD:-admin123}"
RUN_ID="t110$(date +%s)$RANDOM"
USER_A="user-a-$RUN_ID"
USER_B="user-b-$RUN_ID"
PASS="AskUser-${RUN_ID}-123"
MCP_URL="${API_BASE%/api}/mcp"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl
need jq

login() {
  local username="$1"
  local password="$2"
  curl -sS -X POST "$API_BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$password\"}" \
    | jq -r '.access_token // .accessToken // empty'
}

create_user() {
  local username="$1"
  curl -sS -X POST "$API_BASE/users" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$PASS\",\"role\":\"user\"}"
}

delete_user() {
  local id="$1"
  [[ -n "$id" && "$id" != "null" ]] || return 0
  curl -sS -X DELETE "$API_BASE/users/$id" \
    -H "Authorization: Bearer $ADMIN_JWT" >/dev/null 2>&1 || true
}

create_api_key() {
  local jwt="$1"
  curl -sS -X POST "$API_BASE/api-keys" \
    -H "Authorization: Bearer $jwt" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$RUN_ID\"}"
}

mcp_call() {
  local key="$1"
  local arguments_json="$2"
  local headers_file="/tmp/t110-mcp-headers.$$.$RANDOM"

  curl -sS -D "$headers_file" -X POST "$MCP_URL" \
    -H "Authorization: Bearer $key" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t-110","version":"1.0"}}}' \
    -o /dev/null

  local sid
  sid=$(awk 'tolower($1)=="mcp-session-id:"{print $2}' "$headers_file" | tr -d '\r\n')
  rm -f "$headers_file"
  [[ -n "$sid" ]] || fail "MCP initialize returned no session id"

  curl -sS -X POST "$MCP_URL" \
    -H "Authorization: Bearer $key" \
    -H "Mcp-Session-Id: $sid" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$(jq -nc --argjson args "$arguments_json" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"ask_user",arguments:$args}}')"

  curl -sS -X DELETE "$MCP_URL" \
    -H "Authorization: Bearer $key" \
    -H "Mcp-Session-Id: $sid" >/dev/null 2>&1 || true
}

pending() {
  local jwt="$1"
  curl -sS "$API_BASE/questions/pending" -H "Authorization: Bearer $jwt"
}

wait_for_question() {
  local jwt="$1"
  local question="$2"
  local id=""
  for _ in $(seq 1 30); do
    id=$(pending "$jwt" | jq -r --arg q "$question" '.[] | select(.question == $q) | ._id' | head -n1)
    [[ -n "$id" ]] && { echo "$id"; return 0; }
    sleep 0.5
  done
  return 1
}

answer_question() {
  local jwt="$1"
  local id="$2"
  local answer="$3"
  curl -sS -X POST "$API_BASE/questions/$id/answer" \
    -H "Authorization: Bearer $jwt" \
    -H 'Content-Type: application/json' \
    -d "{\"answer\":\"$answer\"}" >/dev/null
}

ADMIN_JWT=$(login "$ADMIN_USER" "$ADMIN_PASS")
[[ -n "$ADMIN_JWT" ]] || fail "admin login failed"
pass "admin jwt obtained"

USER_A_DOC=$(create_user "$USER_A")
USER_B_DOC=$(create_user "$USER_B")
USER_A_ID=$(jq -r '._id' <<<"$USER_A_DOC")
USER_B_ID=$(jq -r '._id' <<<"$USER_B_DOC")

cleanup() {
  delete_user "$USER_A_ID"
  delete_user "$USER_B_ID"
}
trap cleanup EXIT

JWT_A=$(login "$USER_A" "$PASS")
JWT_B=$(login "$USER_B" "$PASS")
[[ -n "$JWT_A" && -n "$JWT_B" ]] || fail "test user login failed"
pass "test users created and logged in"

KEY_B_DOC=$(create_api_key "$JWT_B")
KEY_B=$(jq -r '.key' <<<"$KEY_B_DOC")
[[ -n "$KEY_B" && "$KEY_B" != "null" ]] || fail "could not create user B API key"
pass "user B api key created"

Q_BROADCAST="T-110 broadcast $RUN_ID"
BROADCAST_ARGS=$(jq -nc --arg q "$Q_BROADCAST" '{question:$q, timeoutSeconds:20}')
BROADCAST_OUT="/tmp/t110-broadcast-$RUN_ID.out"
mcp_call "$KEY_B" "$BROADCAST_ARGS" >"$BROADCAST_OUT" &
BROADCAST_PID=$!

QID_A=$(wait_for_question "$JWT_A" "$Q_BROADCAST") || fail "broadcast question not visible to user A"
QID_B=$(wait_for_question "$JWT_B" "$Q_BROADCAST") || fail "broadcast question not visible to user B"
[[ "$QID_A" == "$QID_B" ]] || fail "broadcast resolved to different question ids for A/B"

QUESTION_DOC=$(curl -sS "$API_BASE/questions/$QID_A" -H "Authorization: Bearer $JWT_A")
jq -e --arg user "$USER_B_ID" '(.targetUserId == null) and ((.createdByUserId | tostring) == $user)' <<<"$QUESTION_DOC" >/dev/null \
  || fail "broadcast audit/target fields wrong: $(jq -c '{targetUserId, createdByUserId}' <<<"$QUESTION_DOC")"

answer_question "$JWT_A" "$QID_A" "broadcast-ok"
wait "$BROADCAST_PID"
grep -q 'broadcast-ok' "$BROADCAST_OUT" || fail "broadcast ask_user did not return answer"
pass "broadcast ask_user is visible to both users and keeps createdByUserId=userB"

Q_TARGETED="T-110 targeted $RUN_ID"
TARGETED_ARGS=$(jq -nc --arg q "$Q_TARGETED" --arg username "$USER_A" '{question:$q, targetUsername:$username, timeoutSeconds:20}')
TARGETED_OUT="/tmp/t110-targeted-$RUN_ID.out"
mcp_call "$KEY_B" "$TARGETED_ARGS" >"$TARGETED_OUT" &
TARGETED_PID=$!

QID_TARGETED=$(wait_for_question "$JWT_A" "$Q_TARGETED") || fail "targeted question not visible to user A"
if pending "$JWT_B" | jq -e --arg q "$Q_TARGETED" 'any(.[]; .question == $q)' >/dev/null; then
  fail "targeted question is visible to user B"
fi

TARGETED_DOC=$(curl -sS "$API_BASE/questions/$QID_TARGETED" -H "Authorization: Bearer $JWT_A")
jq -e --arg target "$USER_A_ID" --arg creator "$USER_B_ID" \
  '((.targetUserId | tostring) == $target) and ((.createdByUserId | tostring) == $creator)' \
  <<<"$TARGETED_DOC" >/dev/null \
  || fail "targeted audit/target fields wrong: $(jq -c '{targetUserId, createdByUserId}' <<<"$TARGETED_DOC")"

answer_question "$JWT_A" "$QID_TARGETED" "targeted-ok"
wait "$TARGETED_PID"
grep -q 'targeted-ok' "$TARGETED_OUT" || fail "targeted ask_user did not return answer"
pass "targetUsername asks only the addressed user"

UNKNOWN_ARGS=$(jq -nc --arg q "T-110 unknown $RUN_ID" '{question:$q, targetUsername:"missing-user-t110", timeoutSeconds:20}')
UNKNOWN_RES=$(mcp_call "$KEY_B" "$UNKNOWN_ARGS")
grep -q 'Unknown or inactive targetUsername' <<<"$UNKNOWN_RES" \
  || fail "unknown targetUsername did not return clear error: $UNKNOWN_RES"
pass "unknown targetUsername returns a clear error"

echo
echo "All T-110 ask_user multi-user scenarios passed."
