#!/usr/bin/env bash
# E2E smoke test for Task 3 (Phase 0 web-search providers): encrypted
# multi-provider config, active-provider resolution, and REST config endpoints.
#
# Covers:
#   1. PUT /web-search/config with {activeProvider:'searxng', providers:[{type:'searxng'}]} -> 200
#   2. GET /web-search/config -> activeProvider=='searxng', providers[].hasApiKey present
#   3. PUT /web-search/config with a provider apiKey ('tavily'/dummy) -> 200
#   4. GET /web-search/config -> hasApiKey==true for that provider, and the raw
#      response never contains an "apiKey" field (only "hasApiKey").
#
# Usage:
#   API_BASE=http://localhost:3200/api \
#   AUTH_USERNAME=admin AUTH_PASSWORD=admin123 \
#   bash backend/test/web-search-providers.sh
#
# Exit 0 on full pass, non-zero on any assertion failure. Cleanup trap resets
# the config to plain searxng (no key) on exit so the dev server is left in a
# known-good state regardless of pass/fail.

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
USER="${AUTH_USERNAME:-admin}"
PASS="${AUTH_PASSWORD:-admin123}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl
need jq

echo "Login as $USER ..."
JWT=$(curl -sS -X POST "$API_BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | jq -r '.access_token // .accessToken // empty')
[[ -n "$JWT" ]] || fail "login failed"
pass "jwt obtained"

cleanup() {
  curl -sS -X PUT "$API_BASE/web-search/config" \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    -d '{"activeProvider":"searxng","providers":[{"type":"searxng"}]}' >/dev/null || true
}
trap cleanup EXIT

# --- SCENARIO 1: reset config to plain searxng ---
RESP=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PUT "$API_BASE/web-search/config" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"activeProvider":"searxng","providers":[{"type":"searxng"}]}')
[[ "$RESP" == "200" ]] || fail "scenario 1: expected 200 from PUT config, got $RESP"
pass "scenario 1: PUT /web-search/config (searxng, no key) -> 200"

# --- SCENARIO 2: GET config reflects searxng + hasApiKey present ---
CFG=$(curl -sS "$API_BASE/web-search/config" -H "Authorization: Bearer $JWT")
ACTIVE=$(jq -r '.activeProvider' <<<"$CFG")
[[ "$ACTIVE" == "searxng" ]] || fail "scenario 2: expected activeProvider=searxng, got $ACTIVE"
HAS_HASAPIKEY=$(jq -e '.providers[] | has("hasApiKey")' <<<"$CFG" | grep -c true || true)
[[ "$HAS_HASAPIKEY" -ge 1 ]] || fail "scenario 2: expected providers[].hasApiKey to be present"
pass "scenario 2: GET /web-search/config -> activeProvider=searxng, hasApiKey present"

# --- SCENARIO 3: set a dummy key on tavily ---
RESP=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PUT "$API_BASE/web-search/config" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"activeProvider":"searxng","providers":[{"type":"searxng"},{"type":"tavily","apiKey":"dummy"}]}')
[[ "$RESP" == "200" ]] || fail "scenario 3: expected 200 from PUT config with tavily key, got $RESP"
pass "scenario 3: PUT /web-search/config (tavily + dummy key) -> 200"

# --- SCENARIO 4: GET config -> hasApiKey=true for tavily, no raw "apiKey" field anywhere ---
CFG=$(curl -sS "$API_BASE/web-search/config" -H "Authorization: Bearer $JWT")
TAVILY_HAS_KEY=$(jq -r '.providers[] | select(.type=="tavily") | .hasApiKey' <<<"$CFG")
[[ "$TAVILY_HAS_KEY" == "true" ]] || fail "scenario 4: expected tavily hasApiKey=true, got $TAVILY_HAS_KEY"
jq -e '.providers[] | has("apiKey") | not' <<<"$CFG" >/dev/null \
  || fail "scenario 4: response leaked a raw apiKey field"
pass "scenario 4: GET /web-search/config -> tavily hasApiKey=true, no raw apiKey field"

echo
echo "All Task-3 web-search-provider scenarios passed."
