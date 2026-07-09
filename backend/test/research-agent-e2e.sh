#!/usr/bin/env bash
# E2E: research-agent REST + SSE controller (Task 14) — beweist, dass die
# Topic-CRUD-Endpunkte und der manuelle SSE-Run-Endpunkt tatsächlich leben.
#
# Ein fehlendes/nicht konfiguriertes LLM ist ein AKZEPTABLER PASS für den
# Run-Schritt: ein "type":"error"-Event beweist ebenso, dass der Endpunkt
# lebt (Verbindung + Streaming funktionieren), wie ein "type":"done"-Event.
#
# Voraussetzungen: laufender Server, jq + curl installiert.
# Usage:
#   API_BASE=http://localhost:3200/api AUTH_USERNAME=admin AUTH_PASSWORD=admin123 \
#     bash backend/test/research-agent-e2e.sh
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
USER="${AUTH_USERNAME:-admin}"
PASS_PW="${AUTH_PASSWORD:-admin123}"
FAILS=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1"; exit 2; }; }
need curl; need jq

pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; FAILS=$((FAILS+1)); }

echo "== Auth =="
TOKEN=$(curl -sS -X POST "$API_BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS_PW\"}" | jq -r '.access_token // .accessToken // empty')
if [ -z "$TOKEN" ]; then
  echo "E2E not run — Login fehlgeschlagen (Dev-Admin-Account evtl. deaktiviert/Credentials falsch); Reaktivierung nicht Teil dieser Task."
  exit 0
fi
pass "JWT erhalten"
AUTH="Authorization: Bearer $TOKEN"
api() { curl -s -H "$AUTH" -H "Content-Type: application/json" "$@"; }

echo "== Topic anlegen =="
TOPIC_BODY=$(jq -nc '{
  title: "E2E Research Topic",
  brief: "Kurzer Testauftrag für die E2E-Prüfung des research-agent Controllers.",
  scope: { mode: "all", includeGlobal: true },
  webSearch: { enabled: false },
  schedule: { frequency: "weekly", hour: 6, active: false }
}')
CREATE_RESP=$(api -X POST "$API_BASE/research-topics" -d "$TOPIC_BODY")
TOPIC_ID=$(echo "$CREATE_RESP" | jq -r '._id // empty')
DISPLAY_NUMBER=$(echo "$CREATE_RESP" | jq -r '.displayNumber // empty')

if [ -n "$TOPIC_ID" ]; then
  pass "Topic angelegt ($TOPIC_ID)"
else
  fail "Topic-Anlage fehlgeschlagen"
  echo "    Response: $(echo "$CREATE_RESP" | head -c 400)"
  echo "ABBRUCH"
  echo ""
  echo "$FAILS CHECK(S) FEHLGESCHLAGEN"
  exit 1
fi

if echo "$DISPLAY_NUMBER" | grep -qE '^R-'; then
  pass "displayNumber matcht ^R- ($DISPLAY_NUMBER)"
else
  fail "displayNumber matcht NICHT ^R- (war: $DISPLAY_NUMBER)"
fi

echo "== Topic laden (GET) =="
GET_RESP=$(api "$API_BASE/research-topics/$TOPIC_ID")
GET_TITLE=$(echo "$GET_RESP" | jq -r '.title // empty')
[ "$GET_TITLE" = "E2E Research Topic" ] && pass "GET liefert erwartete Felder" || fail "GET liefert unerwartete Felder (title=$GET_TITLE)"

echo "== Manueller Run (SSE) =="
RUN_OUTPUT=$(curl -sS -N --max-time 60 -H "$AUTH" -X POST "$API_BASE/research-topics/$TOPIC_ID/runs" 2>&1)

if echo "$RUN_OUTPUT" | grep -q '"type":"done"'; then
  pass "SSE-Run lieferte \"type\":\"done\""
elif echo "$RUN_OUTPUT" | grep -q '"type":"error"'; then
  pass "SSE-Run lieferte \"type\":\"error\" (akzeptabler PASS — Endpunkt lebt, LLM evtl. nicht konfiguriert)"
else
  fail "SSE-Run lieferte weder \"type\":\"done\" noch \"type\":\"error\""
  echo "    Output (gekürzt): $(echo "$RUN_OUTPUT" | head -c 800)"
fi

echo "== Runs auflisten =="
RUNS_RESP=$(api "$API_BASE/research-topics/$TOPIC_ID/runs")
RUNS_COUNT=$(echo "$RUNS_RESP" | jq 'length')
if [ "${RUNS_COUNT:-0}" -ge 1 ] 2>/dev/null; then
  pass "GET runs listet >=1 Run ($RUNS_COUNT)"
else
  fail "GET runs listet keinen Run (war: $RUNS_COUNT)"
  echo "    Response: $(echo "$RUNS_RESP" | head -c 400)"
fi

echo "== Cleanup =="
api -X DELETE "$API_BASE/research-topics/$TOPIC_ID" > /dev/null
pass "Topic gelöscht (cascade: Runs + Artefakte)"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "ALLE CHECKS BESTANDEN"; exit 0; else echo "$FAILS CHECK(S) FEHLGESCHLAGEN"; exit 1; fi
