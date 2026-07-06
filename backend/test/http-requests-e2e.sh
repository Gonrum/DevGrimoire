#!/usr/bin/env bash
# E2E: API-Werkbank — beweist (1) Secret wird in den ausgehenden Request injiziert
# und (2) in der gespeicherten History maskiert.
# Voraussetzungen: laufender Server, SECRETS_ENCRYPTION_KEY gesetzt, jq installiert.
# Usage:
#   API_BASE=http://localhost:3200/api AUTH_USERNAME=admin AUTH_PASSWORD=admin123 \
#     bash backend/test/http-requests-e2e.sh
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
USER="${AUTH_USERNAME:-admin}"
PASS_PW="${AUTH_PASSWORD:-admin123}"
ECHO_URL="${ECHO_URL:-https://postman-echo.com/post}"
SECRET_VALUE="s3cr3t-$RANDOM$RANDOM"
FAILS=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1"; exit 2; }; }
need curl; need jq

pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; FAILS=$((FAILS+1)); }

echo "== Login =="
JWT=$(curl -sS -X POST "$API_BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS_PW\"}" | jq -r '.access_token // .accessToken // empty')
[ -n "$JWT" ] || { echo "Login fehlgeschlagen"; exit 1; }
AUTH="Authorization: Bearer $JWT"
api() { curl -s -H "$AUTH" -H "Content-Type: application/json" "$@"; }
pass "JWT erhalten"

echo "== Setup =="
PROJECT_ID=$(api -X POST "$API_BASE/projects" -d "{\"name\":\"e2e-werkbank-$RANDOM\"}" | jq -r '._id // empty')
[ -n "$PROJECT_ID" ] && pass "Projekt angelegt ($PROJECT_ID)" || { fail "Projekt-Anlage"; echo "ABBRUCH"; exit 1; }

api -X POST "$API_BASE/secrets" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"key\":\"TESTSECRET\",\"value\":\"$SECRET_VALUE\"}" > /dev/null
pass "Secret TESTSECRET angelegt"

COLLECTION_ID=$(api -X POST "$API_BASE/projects/$PROJECT_ID/request-collections" -d '{"name":"E2E"}' | jq -r '._id // empty')
[ -n "$COLLECTION_ID" ] && pass "Collection angelegt" || fail "Collection-Anlage"

REQ_BODY=$(jq -nc --arg url "$ECHO_URL" '{
  name:"echo", method:"POST", url:$url,
  headers:[{name:"X-Secret", value:"{{TESTSECRET}}", enabled:true}],
  body:{mode:"raw", contentType:"application/json", raw:"{\"tok\":\"{{TESTSECRET}}\"}"}
}')
REQUEST_ID=$(api -X POST "$API_BASE/request-collections/$COLLECTION_ID/requests" -d "$REQ_BODY" | jq -r '._id // empty')
[ -n "$REQUEST_ID" ] && pass "Request angelegt" || fail "Request-Anlage"

echo "== Senden (globales Secret, kein Environment) =="
SEND_RESP=$(api -X POST "$API_BASE/requests/$REQUEST_ID/send" -d '{}')

# (1) Injektion: die Live-Response (Echo) enthält den Secret-Klartext.
if echo "$SEND_RESP" | grep -q "$SECRET_VALUE"; then
  pass "Secret wurde in den ausgehenden Request injiziert (Echo enthält Klartext)"
else
  fail "Secret NICHT im ausgehenden Request gefunden"
  echo "    Response (gekürzt): $(echo "$SEND_RESP" | head -c 400)"
fi

# unresolvedVariables muss leer sein.
UNRES=$(echo "$SEND_RESP" | jq -r '.unresolvedVariables | length')
[ "$UNRES" = "0" ] && pass "keine unaufgelösten Variablen" || fail "unresolvedVariables=$UNRES"

echo "== History-Masking =="
HISTORY=$(api "$API_BASE/requests/$REQUEST_ID/history?limit=1")

# (2) Masking: History enthält *** und NICHT den Klartext.
if echo "$HISTORY" | grep -q "$SECRET_VALUE"; then
  fail "LEAK — Secret-Klartext in der gespeicherten History gefunden"
else
  pass "kein Secret-Klartext in der History"
fi
if echo "$HISTORY" | grep -q '\*\*\*'; then
  pass "History enthält maskierte Werte (***)"
else
  fail "keine Maskierung in der History gefunden"
fi

echo "== Cleanup =="
api -X DELETE "$API_BASE/request-collections/$COLLECTION_ID" > /dev/null
api -X DELETE "$API_BASE/projects/$PROJECT_ID" > /dev/null 2>&1 || true
pass "aufgeräumt (best effort)"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "ALLE CHECKS BESTANDEN"; exit 0; else echo "$FAILS CHECK(S) FEHLGESCHLAGEN"; exit 1; fi
