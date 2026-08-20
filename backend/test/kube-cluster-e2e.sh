#!/usr/bin/env bash
# E2E für den Kube-Cluster-REST-Layer (K1, Task 6).
# Läuft gegen den laufenden Dev-Server. Braucht: API_URL, API_KEY, PROJECT_ID.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3200}"
# Der Key muss zu einem Admin gehören: PATCH ist Admin-only (RolesGuard),
# ein Nicht-Admin bekäme 403 statt der geprüften 400.
API_KEY="${API_KEY:?API_KEY muss gesetzt sein (DEVGRIMOIRE_API_KEY aus .env, Admin-Rolle)}"
PROJECT_ID="${PROJECT_ID:?PROJECT_ID muss gesetzt sein}"
AUTH=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

# Cluster über sich selbst aufräumen, auch wenn eine Prüfung mittendrin
# scheitert (`fail` ruft `exit 1`) — sonst blockiert ein Fehlschlag jeden
# Re-Run mit demselben Slug (unique Index je Scope).
CLUSTER_ID=""
cleanup() {
  if [ -n "$CLUSTER_ID" ]; then
    curl -sS -o /dev/null "${AUTH[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER_ID}" || true
  fi
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

# Absichtlich unparsbares YAML (unterminierte Flow-Sequenz). Der eingebettete
# Marker steht dafür, dass js-yaml-Fehlermeldungen typischerweise einen
# Ausschnitt des rohen Inputs zitieren — genau das, was NICHT in der
# 400-Response landen darf.
MALFORMED_KUBECONFIG_TEXT='not: [valid, yaml MARKER_SHOULD_NOT_LEAK'

# --- 1. Parse liefert Contexts, aber keine Credentials -------------------
PARSED=$(jq -n --arg kc "$KUBECONFIG_TEXT" '{kubeconfig: $kc}' \
  | curl -sS "${AUTH[@]}" -X POST "${API_URL}/api/kube-clusters/parse-kubeconfig" -d @-)

echo "$PARSED" | jq -e '.contexts[0].contextName == "e2e"' >/dev/null \
  || fail "Context e2e nicht im Parse-Ergebnis"
echo "$PARSED" | grep -q 'e2e-token' && fail "Token ist in der Parse-Response gelandet"
pass "parse-kubeconfig liefert Contexts ohne Credentials"

# --- 2. Kaputtes Kubeconfig ergibt 400, nicht 500, ohne Input-Echo --------
CODE=$(jq -n --arg kc "$MALFORMED_KUBECONFIG_TEXT" '{kubeconfig: $kc}' \
  | curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "${API_URL}/api/kube-clusters/parse-kubeconfig" -d @-)
[ "$CODE" = "400" ] || fail "Kaputtes Kubeconfig ergab HTTP $CODE statt 400"

BODY=$(jq -n --arg kc "$MALFORMED_KUBECONFIG_TEXT" '{kubeconfig: $kc}' \
  | curl -sS "${AUTH[@]}" -X POST "${API_URL}/api/kube-clusters/parse-kubeconfig" -d @-)
echo "$BODY" | grep -q 'MARKER_SHOULD_NOT_LEAK' \
  && fail "Kubeconfig-Rohtext ist in der 400-Response gelandet"
pass "Kaputtes Kubeconfig ergibt 400 ohne Input-Echo"

# --- 3. Cluster anlegen ---------------------------------------------------
CREATED=$(jq -n --arg kc "$KUBECONFIG_TEXT" --arg pid "$PROJECT_ID" \
  '{label:"E2E", slug:"e2e-cluster", projectId:$pid, kubeconfig:$kc, contextName:"e2e", transport:"direct"}' \
  | curl -sS "${AUTH[@]}" -X POST "${API_URL}/api/kube-clusters" -d @-)

CLUSTER_ID=$(echo "$CREATED" | jq -r '._id')
[ "$CLUSTER_ID" != "null" ] || fail "Cluster wurde nicht angelegt: $CREATED"
pass "Cluster angelegt ($CLUSTER_ID)"

# --- 4. GET gibt niemals die Kubeconfig zurück ----------------------------
DETAIL=$(curl -sS "${AUTH[@]}" "${API_URL}/api/kube-clusters/${CLUSTER_ID}")
echo "$DETAIL" | grep -q 'e2e-token' && fail "Kubeconfig in der GET-Response"
echo "$DETAIL" | jq -e '.kubeconfigSecretId == null' >/dev/null \
  || fail "kubeconfigSecretId wird nach aussen gegeben"
pass "GET gibt keine Credentials preis"

# --- 5. readOnly ist Default ----------------------------------------------
echo "$DETAIL" | jq -e '.readOnly == true' >/dev/null || fail "readOnly ist nicht Default"
echo "$DETAIL" | jq -e '.allowMcpWrites == false' >/dev/null || fail "allowMcpWrites ist nicht false"
pass "readOnly=true und allowMcpWrites=false sind Default"

# --- 6. allowMcpWrites bei readOnly wird abgelehnt ------------------------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X PATCH \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}" -d '{"allowMcpWrites": true}')
[ "$CODE" != "403" ] || fail "API_KEY hat keine Admin-Rolle — PATCH ist Admin-only"
[ "$CODE" = "400" ] || fail "allowMcpWrites bei readOnly ergab HTTP $CODE statt 400"
pass "allowMcpWrites setzt readOnly=false voraus"

# --- 7. Verbindungstest scheitert sauber ----------------------------------
TEST=$(curl -sS "${AUTH[@]}" -X POST "${API_URL}/api/kube-clusters/${CLUSTER_ID}/test")
echo "$TEST" | jq -e '.ok == false' >/dev/null || fail "Test gegen cluster.invalid meldete Erfolg"
echo "$TEST" | jq -e '.error | length > 0' >/dev/null || fail "Fehlermeldung fehlt"
pass "Verbindungstest meldet Fehler statt zu werfen"

# --- 8. Audit-Zeile ist entstanden ----------------------------------------
AUDIT=$(curl -sS "${AUTH[@]}" "${API_URL}/api/kube-clusters/${CLUSTER_ID}/audit")
echo "$AUDIT" | jq -e '.total >= 1' >/dev/null || fail "keine Audit-Zeile nach dem Test"
echo "$AUDIT" | jq -e '.items[0].action == "connect"' >/dev/null || fail "Audit-Action ist nicht connect"
echo "$AUDIT" | jq -e '.items[0].sourceContext == "rest"' >/dev/null || fail "sourceContext ist nicht rest"
pass "Verbindungstest hinterlässt eine Audit-Zeile"

# --- 9. Nicht-numerisches limit auf /audit wird abgelehnt -----------------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/audit?limit=abc")
[ "$CODE" = "400" ] || fail "?limit=abc auf /audit ergab HTTP $CODE statt 400"
pass "audit lehnt nicht-numerisches limit mit 400 ab (statt NaN durchzureichen)"

# --- 10. Löschen räumt auf -------------------------------------------------
curl -sS "${AUTH[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER_ID}" >/dev/null
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${API_URL}/api/kube-clusters/${CLUSTER_ID}")
[ "$CODE" = "404" ] || fail "Cluster nach DELETE noch da (HTTP $CODE)"
pass "DELETE entfernt den Cluster"
CLUSTER_ID=""

echo ""
echo "Kube cluster E2E: alle Prüfungen bestanden"
