#!/usr/bin/env bash
# E2E: Streaming-Download — Ticket minten, per Ticket streamen, Single-use + invalid.
# Auth für den Mint-Call via DEVGRIMOIRE_API_KEY; der Download-GET ist @Public (Ticket).
# Usage:
#   API_BASE=http://localhost:3200/api DEVGRIMOIRE_API_KEY=cv_... bash backend/test/http-requests-download-e2e.sh
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
ORIGIN="${API_BASE%/api}"
API_KEY="${DEVGRIMOIRE_API_KEY:?DEVGRIMOIRE_API_KEY muss gesetzt sein}"
ECHO_URL="${ECHO_URL:-https://postman-echo.com/get}"
AUTH="Authorization: Bearer $API_KEY"
FAILS=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1"; exit 2; }; }
need curl; need jq

api() { curl -s -H "$AUTH" -H "Content-Type: application/json" "$@"; }
pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; FAILS=$((FAILS+1)); }

echo "== Setup =="
PROJECT_ID=$(api -X POST "$API_BASE/projects" -d "{\"name\":\"e2e-dl-$RANDOM\"}" | jq -r '._id // empty')
[ -n "$PROJECT_ID" ] && pass "Projekt ($PROJECT_ID)" || { fail "Projekt"; exit 1; }
COLLECTION_ID=$(api -X POST "$API_BASE/projects/$PROJECT_ID/request-collections" -d '{"name":"DL"}' | jq -r '._id // empty')
REQ_BODY=$(jq -nc --arg url "$ECHO_URL" '{name:"download-test", method:"GET", url:$url}')
REQUEST_ID=$(api -X POST "$API_BASE/request-collections/$COLLECTION_ID/requests" -d "$REQ_BODY" | jq -r '._id // empty')
[ -n "$REQUEST_ID" ] && pass "Request ($REQUEST_ID)" || fail "Request"

echo "== Ticket minten =="
DL_URL=$(api -X POST "$API_BASE/requests/$REQUEST_ID/download-ticket" -d '{}' | jq -r '.url // empty')
[ -n "$DL_URL" ] && pass "Ticket-URL erhalten" || fail "Ticket"

echo "== Download (öffentlich, per Ticket) =="
HDR=$(mktemp); BODY=$(mktemp)
CODE=$(curl -s -o "$BODY" -D "$HDR" -w '%{http_code}' "$ORIGIN$DL_URL")
[ "$CODE" = "200" ] && pass "HTTP 200" || fail "Download-Status: $CODE"
grep -qi '^content-disposition:.*attachment' "$HDR" && pass "Content-Disposition: attachment" || fail "kein attachment-Header"
grep -q '"url"' "$BODY" && pass "gestreamter Body enthält erwarteten Inhalt" || fail "unerwarteter Body"

echo "== Single-use =="
CODE2=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN$DL_URL")
[ "$CODE2" = "401" ] && pass "verbrauchtes Ticket → 401" || fail "erwartete 401, bekam $CODE2"

echo "== Ungültiges Ticket =="
CODE3=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/api/requests/$REQUEST_ID/download?ticket=garbage")
[ "$CODE3" = "401" ] && pass "ungültiges Ticket → 401" || fail "erwartete 401, bekam $CODE3"

echo "== Cleanup =="
rm -f "$HDR" "$BODY"
api -X DELETE "$API_BASE/request-collections/$COLLECTION_ID" > /dev/null
api -X DELETE "$API_BASE/projects/$PROJECT_ID" > /dev/null 2>&1 || true
pass "aufgeräumt"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "ALLE CHECKS BESTANDEN"; exit 0; else echo "$FAILS CHECK(S) FEHLGESCHLAGEN"; exit 1; fi
