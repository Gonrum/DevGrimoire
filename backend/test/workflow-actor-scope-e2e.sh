#!/usr/bin/env bash
# E2E für T-505: Workflow-Definitionen und -Läufe prüfen den Scope des Akteurs.
#
# Legt mit dem Admin-Key zwei Wegwerf-Projekte (A, B) und je einen Workflow an,
# dazu einen API-Key, der auf Projekt A verengt ist. Mit diesem Key muss
# Projekt B unsichtbar und unveränderlich sein. Räumt alles wieder auf.
#
# Braucht: API_KEY (DEVGRIMOIRE_API_KEY aus .env, Admin-Rolle). Optional API_URL.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3200}"
API_KEY="${API_KEY:?API_KEY muss gesetzt sein (DEVGRIMOIRE_API_KEY aus .env)}"
ADMIN=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

PROJ_A="" PROJ_B="" WF_A="" WF_B="" KEY_ID=""
cleanup() {
  for wf in "$WF_A" "$WF_B"; do
    [ -n "$wf" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/workflows/${wf}" || true
  done
  [ -n "$KEY_ID" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/api-keys/${KEY_ID}" || true
  for p in "$PROJ_A" "$PROJ_B"; do
    [ -n "$p" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/projects/${p}" || true
  done
}
trap cleanup EXIT

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=('"$1"');process.stdout.write(r===undefined?"":String(r))})'; }

STAMP="$(date +%s)"
PROJ_A="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/projects" -d "{\"name\":\"t505-a-${STAMP}\"}" | json 'v._id')"
PROJ_B="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/projects" -d "{\"name\":\"t505-b-${STAMP}\"}" | json 'v._id')"
[ -n "$PROJ_A" ] && [ -n "$PROJ_B" ] || fail "Projekte nicht angelegt"

mkwf() {
  curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/workflows" \
    -d "{\"scope\":\"project\",\"projectId\":\"$1\",\"name\":\"t505-$2-${STAMP}\"}" | json 'v._id'
}
WF_A="$(mkwf "$PROJ_A" a)"
WF_B="$(mkwf "$PROJ_B" b)"
[ -n "$WF_A" ] && [ -n "$WF_B" ] || fail "Workflows nicht angelegt"
pass "Wegwerf-Projekte und Workflows angelegt"

KEY_RES="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/api-keys" \
  -d "{\"name\":\"t505-${STAMP}\",\"projectScopeMode\":\"allowlist\",\"allowedProjectIds\":[\"${PROJ_A}\"]}")"
KEY_ID="$(echo "$KEY_RES" | json 'v._id ?? v.id ?? v.apiKey?._id')"
NARROW="$(echo "$KEY_RES" | json 'v.key ?? v.rawKey ?? v.token')"
[ -n "$KEY_ID" ] && [ -n "$NARROW" ] || fail "verengter Key nicht angelegt: $KEY_RES"
N=(-H "Authorization: Bearer ${NARROW}" -H "Content-Type: application/json")
pass "auf Projekt A verengter Key angelegt"

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

LIST="$(curl -sS "${N[@]}" "${API_URL}/api/workflows?limit=200")"
echo "$LIST" | json "v.some(w=>w._id==='${WF_A}')" | grep -qx true || fail "eigener Workflow fehlt in der Liste"
echo "$LIST" | json "v.some(w=>w._id==='${WF_B}')" | grep -qx false || fail "fremder Workflow in der Liste"
pass "Liste: eigener Workflow sichtbar, fremder nicht"

LIST_B="$(curl -sS "${N[@]}" "${API_URL}/api/workflows?projectId=${PROJ_B}")"
[ "$(echo "$LIST_B" | json 'v.length')" = "0" ] || fail "Filter projectId=B liefert trotzdem Treffer"
pass "Liste mit projectId=B: leer"

[ "$(status "${N[@]}" "${API_URL}/api/workflows/${WF_A}")" = "200" ] || fail "GET eigener Workflow nicht 200"
[ "$(status "${N[@]}" "${API_URL}/api/workflows/${WF_B}")" = "403" ] || fail "GET fremder Workflow nicht 403"
pass "GET: eigener 200, fremder 403"

[ "$(status "${N[@]}" "${API_URL}/api/workflows/${WF_B}/secrets")" = "403" ] || fail "GET fremde Secrets nicht 403"
pass "GET :id/secrets fremd: 403"

[ "$(status "${N[@]}" -X PUT "${API_URL}/api/workflows/${WF_B}" -d '{"name":"übernommen"}')" = "403" ] || fail "PUT fremd nicht 403"
NAME_B="$(curl -sS "${ADMIN[@]}" "${API_URL}/api/workflows/${WF_B}" | json 'v.name')"
[ "$NAME_B" = "t505-b-${STAMP}" ] || fail "fremder Workflow wurde umbenannt: $NAME_B"
pass "PUT fremd: 403, Name unverändert"

[ "$(status "${N[@]}" -X POST "${API_URL}/api/workflows" -d "{\"scope\":\"project\",\"projectId\":\"${PROJ_B}\",\"name\":\"x\"}")" = "403" ] \
  || fail "POST in fremdes Projekt nicht 403"
pass "POST in fremdes Projekt: 403"

[ "$(status "${N[@]}" -X DELETE "${API_URL}/api/workflows/${WF_B}")" = "403" ] || fail "DELETE fremd nicht 403"
[ "$(status "${ADMIN[@]}" "${API_URL}/api/workflows/${WF_B}")" = "200" ] || fail "fremder Workflow ist weg"
pass "DELETE fremd: 403, Workflow existiert noch"

RUNS="$(curl -sS "${N[@]}" "${API_URL}/api/workflows/runs/list?projectId=${PROJ_B}")"
[ "$(echo "$RUNS" | json 'v.length')" = "0" ] || fail "Lauf-Liste fremdes Projekt nicht leer"
pass "Lauf-Liste mit projectId=B: leer"

echo "Alle T-505-Prüfungen bestanden."
