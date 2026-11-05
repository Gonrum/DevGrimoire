#!/usr/bin/env bash
# E2E für T-477: Fremdzugriff auf Kube-Cluster über einen verengten API-Key.
#
# Legt mit dem Admin-Key zwei Wegwerf-Projekte (A, B) und in B einen Cluster
# an (nur geparst, keine echte Verbindung), dazu einen auf Projekt A
# verengten API-Key. Mit diesem Key darf der Cluster in B auf keiner der
# Cluster-Routen erreichbar sein. Räumt alles wieder auf.
#
# Braucht: API_KEY (DEVGRIMOIRE_API_KEY aus .env, Admin-Rolle), jq. Optional API_URL.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3200}"
API_KEY="${API_KEY:?API_KEY muss gesetzt sein (DEVGRIMOIRE_API_KEY aus .env)}"
ADMIN=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

PROJ_A="" PROJ_B="" CLUSTER="" KEY_ID=""
cleanup() {
  [ -n "$CLUSTER" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER}" || true
  [ -n "$KEY_ID" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/api-keys/${KEY_ID}" || true
  for p in "$PROJ_A" "$PROJ_B"; do
    [ -n "$p" ] && curl -sS -o /dev/null "${ADMIN[@]}" -X DELETE "${API_URL}/api/projects/${p}" || true
  done
}
trap cleanup EXIT

KUBECONFIG_TEXT=$(cat <<'EOF'
apiVersion: v1
kind: Config
current-context: e2e
contexts:
  - name: e2e
    context: { cluster: e2e-cluster, user: e2e-user }
clusters:
  - name: e2e-cluster
    cluster:
      server: https://cluster.invalid:6443
      certificate-authority-data: Zm9v
users:
  - name: e2e-user
    user: { token: e2e-token }
EOF
)

STAMP="$(date +%s)"
PROJ_A="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/projects" -d "{\"name\":\"t477-a-${STAMP}\"}" | jq -r '._id')"
PROJ_B="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/projects" -d "{\"name\":\"t477-b-${STAMP}\"}" | jq -r '._id')"
[ "$PROJ_A" != "null" ] && [ "$PROJ_B" != "null" ] || fail "Projekte nicht angelegt"

newcluster() { # $1 = auth-array-name, $2 = projectId, $3 = slug → schreibt Body, gibt Status aus
  local -n auth="$1"
  jq -n --arg kc "$KUBECONFIG_TEXT" --arg pid "$2" --arg slug "$3" \
    '{label:$slug, slug:$slug, projectId:$pid, kubeconfig:$kc, contextName:"e2e", transport:"direct"}' \
    | curl -sS -o "${BODY_FILE}" -w '%{http_code}' "${auth[@]}" -X POST "${API_URL}/api/kube-clusters" -d @-
}
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"; cleanup' EXIT

[ "$(newcluster ADMIN "$PROJ_B" "t477-b")" = "201" ] || fail "Cluster in B nicht angelegt: $(cat "$BODY_FILE")"
CLUSTER="$(jq -r '.id // ._id' "$BODY_FILE")"
pass "Wegwerf-Projekte und Cluster in B angelegt"

KEY_RES="$(curl -sS "${ADMIN[@]}" -X POST "${API_URL}/api/api-keys" \
  -d "{\"name\":\"t477-${STAMP}\",\"projectScopeMode\":\"allowlist\",\"allowedProjectIds\":[\"${PROJ_A}\"]}")"
KEY_ID="$(echo "$KEY_RES" | jq -r '._id // .id')"
NARROW="$(echo "$KEY_RES" | jq -r '.key // .rawKey // .token')"
[ "$KEY_ID" != "null" ] && [ "$NARROW" != "null" ] || fail "verengter Key nicht angelegt: $KEY_RES"
N=(-H "Authorization: Bearer ${NARROW}" -H "Content-Type: application/json")
pass "auf Projekt A verengter Key angelegt"

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
expect() { # $1 = erwarteter Status, $2 = Beschreibung, Rest = curl-Argumente
  local want="$1" what="$2"; shift 2
  local got; got="$(status "$@")"
  [ "$got" = "$want" ] || fail "$what: HTTP $got statt $want"
  pass "$what: $want"
}

[ "$(curl -sS "${N[@]}" "${API_URL}/api/kube-clusters?projectId=${PROJ_B}" | jq 'length')" = "0" ] \
  || fail "Liste ?projectId=B zeigt den fremden Cluster"
pass "Liste ?projectId=B: leer"

expect 403 "GET /:id fremd"            "${N[@]}" "${API_URL}/api/kube-clusters/${CLUSTER}"
expect 403 "GET /:id/audit fremd"      "${N[@]}" "${API_URL}/api/kube-clusters/${CLUSTER}/audit"
expect 403 "POST /:id/test fremd"      "${N[@]}" -X POST "${API_URL}/api/kube-clusters/${CLUSTER}/test"
expect 403 "PATCH /:id fremd"          "${N[@]}" -X PATCH "${API_URL}/api/kube-clusters/${CLUSTER}" -d '{"label":"übernommen"}'
expect 403 "GET /:id/namespaces fremd" "${N[@]}" "${API_URL}/api/kube-clusters/${CLUSTER}/namespaces"
expect 403 "DELETE /:id fremd"         "${N[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER}"

[ "$(curl -sS "${ADMIN[@]}" "${API_URL}/api/kube-clusters/${CLUSTER}" | jq -r '.label')" = "t477-b" ] \
  || fail "fremder Cluster wurde verändert oder gelöscht"
pass "fremder Cluster unverändert vorhanden"

[ "$(newcluster N "$PROJ_B" "t477-intruder")" = "403" ] || fail "POST in fremdes Projekt: $(cat "$BODY_FILE")"
[ "$(curl -sS "${ADMIN[@]}" "${API_URL}/api/kube-clusters?projectId=${PROJ_B}" | jq 'length')" = "1" ] \
  || fail "trotz 403 ist ein zweiter Cluster in B entstanden"
pass "POST in fremdes Projekt: 403, nichts angelegt"

# Gegenprobe: im eigenen Projekt funktioniert derselbe Key.
[ "$(newcluster N "$PROJ_A" "t477-own")" = "201" ] || fail "POST im eigenen Projekt: $(cat "$BODY_FILE")"
OWN="$(jq -r '.id // ._id' "$BODY_FILE")"
expect 200 "GET /:id eigen"       "${N[@]}" "${API_URL}/api/kube-clusters/${OWN}"
expect 200 "GET /:id/audit eigen" "${N[@]}" "${API_URL}/api/kube-clusters/${OWN}/audit"
expect 204 "DELETE /:id eigen"    "${N[@]}" -X DELETE "${API_URL}/api/kube-clusters/${OWN}"

echo "Alle T-477-Prüfungen bestanden."
