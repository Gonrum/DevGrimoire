#!/usr/bin/env bash
# E2E: Webrecherche P1 — Warteschlange, Steuerung, Verschieben gegen den laufenden Stack.
# Ein Fake-LLM-Endpunkt (workflow-Pool) sorgt dafür, dass der Lauf starten kann.
# Der Lese-Inhalt wird NICHT geprüft (SSRF-Schutz sperrt den lokalen Fake-Webserver);
# der volle Lauf mit echtem Modell ist der manuelle Test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_BASE="${API_BASE:-http://localhost:3200/api}"
FAKE_PORT="${FAKE_PORT:-18080}"
# Backend-Container erreicht den Host über host.docker.internal (extra_hosts: host-gateway).
FAKE_URL="${FAKE_URL:-http://host.docker.internal:$FAKE_PORT}"
KEY="$(grep -E '^DEVGRIMOIRE_API_KEY=' "$ROOT/.env" | cut -d= -f2- | tr -d "\"'")"
[ -n "$KEY" ] || { echo "DEVGRIMOIRE_API_KEY fehlt in .env"; exit 2; }
command -v jq >/dev/null && command -v curl >/dev/null || { echo "jq/curl fehlen"; exit 2; }

TOTAL=0; FAILS=0
pass() { TOTAL=$((TOTAL+1)); echo "pass $1"; }
fail() { TOTAL=$((TOTAL+1)); FAILS=$((FAILS+1)); echo "fail $1"; }
api() { curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }

FAKE_PID=""; EP_ID=""; IDS=()
cleanup() {
  set +e
  for rid in "${IDS[@]:-}"; do [ -n "$rid" ] && code -X DELETE "$API_BASE/research/$rid" >/dev/null; done
  [ -n "$EP_ID" ] && api -X DELETE "$API_BASE/llm-endpoints/$EP_ID" >/dev/null
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
}
trap cleanup EXIT

status_of() { api "$API_BASE/research/$1" | jq -r '.status // empty'; }
wait_status() { # id, Regex, Sekunden
  local i s
  for i in $(seq 1 "$3"); do s="$(status_of "$1")"; [[ "$s" =~ $2 ]] && { echo "$s"; return 0; }; sleep 1; done
  echo "$s"; return 1
}

HOST=0.0.0.0 PORT="$FAKE_PORT" node "$ROOT/backend/test/research-fake-llm.cjs" >/dev/null 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 20); do curl -s "http://127.0.0.1:$FAKE_PORT/seite" >/dev/null && break; sleep 0.25; done
curl -s "http://127.0.0.1:$FAKE_PORT/seite" | grep -q Testseite && pass "Fake-LLM gestartet" || fail "Fake-LLM gestartet"

EP_BODY="$(jq -nc --arg u "$FAKE_URL" '{label:"e2e-fake",provider:"openai-compatible",baseUrl:$u,model:"fake",purposes:["workflow"],concurrency:1,priority:1000}')"
EP_RES="$(api -X POST "$API_BASE/llm-endpoints" -d "$EP_BODY")"
EP_ID="$(echo "$EP_RES" | jq -r '.id // ._id // empty')"
[ -n "$EP_ID" ] && pass "Fake-Endpunkt e2e-fake angelegt" || fail "Fake-Endpunkt angelegt: $EP_RES"

START="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -X POST "$API_BASE/research/start" -d '{"topics":["E2E Testthema"],"depth":"quick"}')"
SC="$(echo "$START" | tail -n1)"; RID="$(echo "$START" | head -n1 | jq -r '.ids[0] // empty')"
[ -n "$RID" ] && IDS+=("$RID")
[ "$SC" = 201 ] && [ -n "$RID" ] && pass "start -> 201, Id $RID" || fail "start -> 201 (war $SC)"

api "$API_BASE/research/queue" | jq -e --arg id "$RID" '[.positions[].id] | index($id) != null' >/dev/null \
  && pass "queue enthält Id" || fail "queue enthält Id"

# Der Lauf kann schnell wechseln; sofort pausieren hält ihn kurz.
PC="$(code -X POST "$API_BASE/research/$RID/pause")"
[ "$PC" = 204 ] && pass "pause -> 204" || fail "pause -> 204 (war $PC)"
S="$(wait_status "$RID" '^paused$' 20)" && pass "Status paused" || fail "Status paused (war $S)"

RC="$(code -X POST "$API_BASE/research/$RID/resume")"
[ "$RC" = 204 ] && pass "resume -> 204" || fail "resume -> 204 (war $RC)"
S="$(wait_status "$RID" '^(queued|running)$' 20)" && pass "Status nach resume: $S" || fail "Status queued/running (war $S)"

QC="$(code -X POST "$API_BASE/research/$RID/cancel")"
[ "$QC" = 204 ] && pass "cancel -> 204" || fail "cancel -> 204 (war $QC)"
S="$(wait_status "$RID" '^cancelled$' 30)" && pass "Status cancelled" || fail "Status cancelled (war $S)"

PROJ="$(api "$API_BASE/projects" | jq -r '(if type=="array" then . else (.items // .projects // .data // []) end)[0] | (.id // ._id) // empty')"
if [ -z "$PROJ" ]; then fail "Projekt für move ermittelt"; else
  MC="$(code -X POST "$API_BASE/research/$RID/move" -d "$(jq -nc --arg p "$PROJ" '{projectId:$p}')")"
  [ "$MC" = 409 ] && pass "move (nicht done) -> 409" || fail "move -> 409 (war $MC)"
fi

BC="$(code -X POST "$API_BASE/research/start" -d '{"topics":["ab"]}')"
[ "$BC" = 400 ] && pass "start mit zu kurzem Thema -> 400" || fail "start 'ab' -> 400 (war $BC)"

DC="$(code -X DELETE "$API_BASE/research/$RID")"
[ "$DC" = 204 ] && pass "DELETE -> 204" || fail "DELETE -> 204 (war $DC)"
GC="$(code "$API_BASE/research/$RID")"
[ "$GC" = 404 ] && pass "GET nach DELETE -> 404" || fail "GET nach DELETE -> 404 (war $GC)"

echo "$((TOTAL-FAILS))/$TOTAL bestanden"
[ "$FAILS" -eq 0 ] || exit 1
