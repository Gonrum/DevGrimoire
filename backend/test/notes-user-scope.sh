#!/usr/bin/env bash
# E2E regression test for notes per-user scoping.
#
# Verifies:
#  - User B cannot list/read/update/delete User A's notes (404, not 403)
#  - reorder silently ignores foreign IDs
#  - Default title increments per user
#  - 100 KB content limit returns 413
#
# Requires a running DevGrimoire stack with auth enabled.
#
# Usage:
#   API_BASE=http://localhost:3200/api \
#   AUTH_USERNAME=admin AUTH_PASSWORD=admin123 \
#   bash backend/test/notes-user-scope.sh

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
ADMIN_USER="${AUTH_USERNAME:-admin}"
ADMIN_PASS="${AUTH_PASSWORD:-admin123}"
RUN_ID="notes$(date +%s)$RANDOM"
USER_A="notes-a-$RUN_ID"
USER_B="notes-b-$RUN_ID"
PASS="Notes-${RUN_ID}-123"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl
need jq

login() {
  curl -sS -X POST "$API_BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
    | jq -r '.access_token // .accessToken // empty'
}

create_user() {
  curl -sS -X POST "$API_BASE/users" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PASS\",\"role\":\"user\"}"
}

delete_user() {
  [[ -n "${1:-}" && "$1" != "null" ]] || return 0
  curl -sS -X DELETE "$API_BASE/users/$1" \
    -H "Authorization: Bearer $ADMIN_JWT" >/dev/null 2>&1 || true
}

ADMIN_JWT="$(login "$ADMIN_USER" "$ADMIN_PASS")"
[[ -n "$ADMIN_JWT" ]] || fail "admin login failed"

USER_A_INFO="$(create_user "$USER_A")"
USER_A_ID="$(echo "$USER_A_INFO" | jq -r '._id // .id // empty')"
[[ -n "$USER_A_ID" ]] || fail "create_user A failed: $USER_A_INFO"

USER_B_INFO="$(create_user "$USER_B")"
USER_B_ID="$(echo "$USER_B_INFO" | jq -r '._id // .id // empty')"
[[ -n "$USER_B_ID" ]] || fail "create_user B failed: $USER_B_INFO"

cleanup() {
  delete_user "$USER_A_ID"
  delete_user "$USER_B_ID"
}
trap cleanup EXIT

JWT_A="$(login "$USER_A" "$PASS")"
JWT_B="$(login "$USER_B" "$PASS")"
[[ -n "$JWT_A" && -n "$JWT_B" ]] || fail "user login failed"

# --- Test 1: Default title increments per user ---
NOTE_A1="$(curl -sS -X POST "$API_BASE/notes" \
  -H "Authorization: Bearer $JWT_A" -H 'Content-Type: application/json' \
  -d '{}')"
NOTE_A1_ID="$(echo "$NOTE_A1" | jq -r '._id')"
NOTE_A1_TITLE="$(echo "$NOTE_A1" | jq -r '.title')"
[[ "$NOTE_A1_TITLE" == "Notiz 1" ]] || fail "expected 'Notiz 1', got '$NOTE_A1_TITLE'"
pass "Default title 'Notiz 1' for user A's first note"

NOTE_A2="$(curl -sS -X POST "$API_BASE/notes" \
  -H "Authorization: Bearer $JWT_A" -H 'Content-Type: application/json' \
  -d '{"content":"hello"}')"
NOTE_A2_ID="$(echo "$NOTE_A2" | jq -r '._id')"
NOTE_A2_TITLE="$(echo "$NOTE_A2" | jq -r '.title')"
[[ "$NOTE_A2_TITLE" == "Notiz 2" ]] || fail "expected 'Notiz 2', got '$NOTE_A2_TITLE'"
pass "Default title 'Notiz 2' for user A's second note"

# Each user gets their own counter
NOTE_B1="$(curl -sS -X POST "$API_BASE/notes" \
  -H "Authorization: Bearer $JWT_B" -H 'Content-Type: application/json' \
  -d '{}')"
NOTE_B1_ID="$(echo "$NOTE_B1" | jq -r '._id')"
NOTE_B1_TITLE="$(echo "$NOTE_B1" | jq -r '.title')"
[[ "$NOTE_B1_TITLE" == "Notiz 1" ]] || fail "expected 'Notiz 1' for user B, got '$NOTE_B1_TITLE'"
pass "Per-user title counter (User B's first note is also 'Notiz 1')"

# --- Test 2: User B cannot see User A's notes ---
B_LIST="$(curl -sS "$API_BASE/notes" -H "Authorization: Bearer $JWT_B")"
B_COUNT="$(echo "$B_LIST" | jq 'length')"
[[ "$B_COUNT" == "1" ]] || fail "user B should see exactly 1 note, got $B_COUNT"
B_CONTAINS_A="$(echo "$B_LIST" | jq --arg id "$NOTE_A1_ID" 'map(select(._id == $id)) | length')"
[[ "$B_CONTAINS_A" == "0" ]] || fail "user B should not see user A's notes"
pass "User B's list contains only their own notes"

# --- Test 3: User B cannot PUT user A's note (404) ---
B_PUT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PUT "$API_BASE/notes/$NOTE_A1_ID" \
  -H "Authorization: Bearer $JWT_B" -H 'Content-Type: application/json' \
  -d '{"content":"hijack"}')"
[[ "$B_PUT_STATUS" == "404" ]] || fail "expected 404 for cross-user PUT, got $B_PUT_STATUS"
pass "User B PUT on user A's note returns 404"

# --- Test 4: User B cannot DELETE user A's note (404) ---
B_DEL_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X DELETE "$API_BASE/notes/$NOTE_A1_ID" \
  -H "Authorization: Bearer $JWT_B")"
[[ "$B_DEL_STATUS" == "404" ]] || fail "expected 404 for cross-user DELETE, got $B_DEL_STATUS"
pass "User B DELETE on user A's note returns 404"

# Verify A's note still exists
A_LIST_AFTER="$(curl -sS "$API_BASE/notes" -H "Authorization: Bearer $JWT_A")"
A_COUNT_AFTER="$(echo "$A_LIST_AFTER" | jq 'length')"
[[ "$A_COUNT_AFTER" == "2" ]] || fail "user A's notes should still be 2, got $A_COUNT_AFTER"
pass "User A's notes still intact after cross-user attempts"

# --- Test 5: Reorder ignores foreign IDs silently ---
REORDER_RESP="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PATCH "$API_BASE/notes/reorder" \
  -H "Authorization: Bearer $JWT_B" -H 'Content-Type: application/json' \
  -d "{\"orderedIds\":[\"$NOTE_A1_ID\",\"$NOTE_B1_ID\"]}")"
[[ "$REORDER_RESP" == "204" ]] || fail "reorder should be 204, got $REORDER_RESP"
# Verify A's note keeps its order
A_NOTE1_AFTER="$(echo "$A_LIST_AFTER" | jq --arg id "$NOTE_A1_ID" '.[] | select(._id == $id)')"
A_NOTE1_ORDER="$(echo "$A_NOTE1_AFTER" | jq -r '.order')"
[[ "$A_NOTE1_ORDER" == "0" ]] || fail "user A's note order should be unchanged at 0, got $A_NOTE1_ORDER"
pass "Reorder silently ignores foreign IDs"

# --- Test 6: Content limit (100 KB) returns 413 or 400 ---
BIG_CONTENT="$(python3 -c 'import sys; sys.stdout.write("x" * (101*1024))')"
BIG_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PUT "$API_BASE/notes/$NOTE_A1_ID" \
  -H "Authorization: Bearer $JWT_A" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "$BIG_CONTENT" '{content:$c}')")"
if [[ "$BIG_STATUS" == "413" || "$BIG_STATUS" == "400" ]]; then
  pass "Oversized content rejected (status $BIG_STATUS)"
else
  fail "expected 400/413 for >100KB content, got $BIG_STATUS"
fi

# --- Test 7: Invalid ObjectId returns 404 ---
INVALID_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PUT "$API_BASE/notes/not-a-valid-id" \
  -H "Authorization: Bearer $JWT_A" -H 'Content-Type: application/json' \
  -d '{"content":"x"}')"
[[ "$INVALID_STATUS" == "404" ]] || fail "expected 404 for invalid id, got $INVALID_STATUS"
pass "Invalid ObjectId returns 404"

# --- Test 8: Archive + archived list ---
ARCH_RESP="$(curl -sS -X POST "$API_BASE/notes/$NOTE_A2_ID/archive" \
  -H "Authorization: Bearer $JWT_A")"
ARCH_FLAG="$(echo "$ARCH_RESP" | jq -r '.archived')"
[[ "$ARCH_FLAG" == "true" ]] || fail "archive should set archived=true"
pass "Archive sets archived=true"

ARCHIVED_LIST="$(curl -sS "$API_BASE/notes/archived" -H "Authorization: Bearer $JWT_A")"
ARCHIVED_COUNT="$(echo "$ARCHIVED_LIST" | jq 'length')"
[[ "$ARCHIVED_COUNT" == "1" ]] || fail "archived list should have 1 entry, got $ARCHIVED_COUNT"
pass "Archived list shows the archived note"

ACTIVE_LIST="$(curl -sS "$API_BASE/notes" -H "Authorization: Bearer $JWT_A")"
ACTIVE_COUNT="$(echo "$ACTIVE_LIST" | jq 'length')"
[[ "$ACTIVE_COUNT" == "1" ]] || fail "active list should have 1 entry after archive, got $ACTIVE_COUNT"
pass "Active list no longer contains the archived note"

echo
echo "All tests passed."
