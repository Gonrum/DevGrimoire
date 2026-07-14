#!/usr/bin/env bash
# E2E regression test for the Stacks module (standalone, no projectId).
#
# Requires a running DevGrimoire stack with auth enabled.
# Usage:
#   API_BASE=http://localhost:3200/api bash backend/test/stacks-e2e.sh
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl; need jq

API_KEY="${DEVGRIMOIRE_API_KEY:-$(grep -E '^DEVGRIMOIRE_API_KEY=' "$(git rev-parse --show-toplevel)/.env" | head -1 | cut -d= -f2-)}"
[[ -n "$API_KEY" ]] || fail "no DEVGRIMOIRE_API_KEY in env or .env"
AUTH=(-H "Authorization: Bearer $API_KEY")

STACK_ID=""
cleanup() { [[ -n "$STACK_ID" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# create
STACK_ID="$(curl -sS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Stack","description":"desc"}' "$API_BASE/stacks" | jq -r '._id')"
[[ -n "$STACK_ID" && "$STACK_ID" != "null" ]] || fail "create stack"
pass "created stack $STACK_ID"

# add two entries
curl -sS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"title":"Frontend","content":"React 19"}' "$API_BASE/stacks/$STACK_ID/entries" >/dev/null
curl -sS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"title":"Backend","content":"NestJS"}' "$API_BASE/stacks/$STACK_ID/entries" >/dev/null

DETAIL="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID")"
[[ "$(echo "$DETAIL" | jq '.entries | length')" == "2" ]] || fail "expected 2 entries"
[[ "$(echo "$DETAIL" | jq -r '.entries[0].title')" == "Frontend" ]] || fail "order 0 != Frontend"
pass "two entries in order"

E0="$(echo "$DETAIL" | jq -r '.entries[0]._id')"
E1="$(echo "$DETAIL" | jq -r '.entries[1]._id')"

# reorder (swap)
curl -sS -X PATCH "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"entryIds\":[\"$E1\",\"$E0\"]}" "$API_BASE/stacks/$STACK_ID/reorder" >/dev/null
FIRST="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID" | jq -r '.entries[0].title')"
[[ "$FIRST" == "Backend" ]] || fail "reorder failed, first=$FIRST"
pass "reorder works"

# update entry
curl -sS -X PATCH "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"content":"NestJS 11"}' "$API_BASE/stacks/$STACK_ID/entries/$E1" >/dev/null

# verify update actually took effect (fetch fresh, not the PATCH response)
UPDATED_CONTENT="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID" | jq -r --arg id "$E1" '.entries[] | select(._id==$id) | .content')"
[[ "$UPDATED_CONTENT" == "NestJS 11" ]] || fail "update entry did not take effect (got: $UPDATED_CONTENT)"
pass "update entry took effect"

# whole-stack export.md
EXPORT="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID/export.md")"
echo "$EXPORT" | grep -q '^# E2E Stack' || fail "export missing stack H1"
echo "$EXPORT" | grep -q '^## Frontend' || fail "export missing section H2"
CD="$(curl -sS -D - -o /dev/null "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID/export.md" | tr -d '\r')"
echo "$CD" | grep -qi 'content-disposition: attachment; filename="e2e-stack.md"' || fail "bad Content-Disposition: $CD"
pass "whole-stack export ok"

# single-entry export.md
ENTRY_EXPORT="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID/entries/$E0/export.md")"
echo "$ENTRY_EXPORT" | grep -q '^# Frontend' || fail "entry export missing H1"
pass "single-entry export ok"

# remove entry
curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID/entries/$E0" >/dev/null
[[ "$(curl -sS "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID" | jq '.entries | length')" == "1" ]] || fail "remove entry"
pass "remove entry ok"

# list shows entryCount
COUNT="$(curl -sS "${AUTH[@]}" "$API_BASE/stacks" | jq --arg id "$STACK_ID" '.[] | select(._id==$id) | .entryCount')"
[[ "$COUNT" == "1" ]] || fail "list entryCount != 1 (got $COUNT)"
pass "list metadata ok"

# delete + 404
curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID" >/dev/null
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API_BASE/stacks/$STACK_ID")"
[[ "$STATUS" == "404" ]] || fail "deleted stack should 404 (got $STATUS)"
STACK_ID=""
pass "delete + 404 ok"

echo "stacks-e2e OK"
