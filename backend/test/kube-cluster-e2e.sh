#!/usr/bin/env bash
# E2E für den Kube-Cluster-REST-Layer (K1, Task 6).
# Läuft gegen den laufenden Dev-Server. Braucht: API_URL, API_KEY, PROJECT_ID.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3200}"
# Der Key muss zu einem Admin gehören: Cluster-CRUD selbst ist NICHT
# admin-only (wie SSH-Connections), aber die beiden Rechte-Flags
# (readOnly=false, allowMcpWrites=true) sind es — pro Feld gegated in
# KubeClustersService.assertFlagPermission(), nicht per Route-Guard. Mit
# einem Nicht-Admin-Key würden Schritt 6b (Admin darf) und mittelbar auch
# Schritt 6 (die 400-Prüfung würde nie erreicht, weil schon der Admin-Gate
# vorher mit 403 abbräche) danebengehen. Der Negativfall — ein Nicht-Admin
# bekommt 403 — lässt sich hier mangels eines Nicht-Admin-Tokens nicht
# exercisen; er ist stattdessen in kube-service-units-check.cjs gepinnt
# (simulierter Actor über RequestContext.run(), beide Richtungen: 403 für
# USER, Erfolg für ADMIN, sowie "kein Actor bleibt ungegated").
API_KEY="${API_KEY:?API_KEY muss gesetzt sein (DEVGRIMOIRE_API_KEY aus .env, Admin-Rolle)}"
PROJECT_ID="${PROJECT_ID:?PROJECT_ID muss gesetzt sein}"
AUTH=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

# Cluster (und ggf. der Wegwerf-User für den ?token=-Test) räumen sich über
# sich selbst auf, auch wenn eine Prüfung mittendrin scheitert (`fail` ruft
# `exit 1`) — sonst blockiert ein Fehlschlag jeden Re-Run mit demselben Slug
# (unique Index je Scope).
CLUSTER_ID=""
TEST_USER_ID=""
cleanup() {
  if [ -n "$CLUSTER_ID" ]; then
    curl -sS -o /dev/null "${AUTH[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER_ID}" || true
  fi
  if [ -n "$TEST_USER_ID" ]; then
    curl -sS -o /dev/null "${AUTH[@]}" -X DELETE "${API_URL}/api/users/${TEST_USER_ID}" || true
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
[ "$CODE" != "403" ] || fail "Admin-Key wurde vom Flag-Gate abgelehnt — sollte nur Nicht-Admins treffen (I3)"
[ "$CODE" = "400" ] || fail "allowMcpWrites bei readOnly ergab HTTP $CODE statt 400"
pass "allowMcpWrites setzt readOnly=false voraus"

# --- 6b. Admin-Pfad: readOnly=false/allowMcpWrites=true sind für den
#         Admin-Key erlaubt (I3, positiver Pfad — der eigentliche Hebel aus
#         der Spec ist erreichbar, nur eben nicht für Nicht-Admins) --------
PATCHED=$(curl -sS "${AUTH[@]}" -X PATCH "${API_URL}/api/kube-clusters/${CLUSTER_ID}" \
  -d '{"readOnly": false, "allowMcpWrites": true}')
echo "$PATCHED" | jq -e '.readOnly == false and .allowMcpWrites == true' >/dev/null \
  || fail "Admin-Key konnte readOnly=false/allowMcpWrites=true nicht setzen: $PATCHED"
pass "Admin-Key darf readOnly=false und allowMcpWrites=true setzen"

# Zustand für die folgenden Schritte zurücksetzen, sonst würde der spätere
# Verbindungstest (Schritt 7) canWrite basierend auf einem inkonsistenten
# gespeicherten Zustand auswerten.
curl -sS -o /dev/null "${AUTH[@]}" -X PATCH "${API_URL}/api/kube-clusters/${CLUSTER_ID}" \
  -d '{"allowMcpWrites": false, "readOnly": true}'

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

# --- Ressourcen-Routen: existieren und scheitern sauber ------------------
CODE=$(curl -sS -o /tmp/kube-res.json -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/resources?kind=Pod&namespace=default")
[ "$CODE" != "404" ] || fail "Route /resources existiert nicht"
[ "$CODE" != "500" ] || fail "Ressourcen-Route ergab 500 statt eines sauberen Fehlers: $(cat /tmp/kube-res.json)"
pass "Ressourcen-Route antwortet ohne Serverfehler (HTTP $CODE)"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/resources?kind=Widget")
[ "$CODE" = "400" ] || fail "unbekanntes Kind ergab HTTP $CODE statt 400"
pass "unbekanntes Kind wird mit 400 abgelehnt"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/resources?kind=Pod&limit=abc")
[ "$CODE" = "400" ] || fail "nicht-numerisches limit ergab HTTP $CODE statt 400"
pass "nicht-numerisches limit wird mit 400 abgelehnt"

# --- Ein Zugriff auf einen unbekannten Cluster ist 404, nicht 500 --------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/000000000000000000000000/resources?kind=Pod")
[ "$CODE" = "404" ] || fail "unbekannte Cluster-Id ergab HTTP $CODE statt 404"
pass "unbekannte Cluster-Id ergibt 404"

# --- Review-Fund (Important 4): der Cluster wird VOR dem ersten SSE-Header
#     aufgelöst — ein unbekannter Cluster bekommt sauberes JSON-404, keinen
#     halb geöffneten Stream (200 mit einem type:error-Event darin). Vorher
#     war das ein reines "kein 500"-Nachweis, der immer bestanden hätte,
#     sobald die Route existiert (unfalsifiable) — jetzt ist es real.
CODE=$(curl -sS -o /tmp/kube-logstream-404.json -w '%{http_code}' "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/000000000000000000000000/logs/stream?namespace=default&pod=api")
[ "$CODE" = "404" ] || fail "logs/stream auf unbekannten Cluster ergab HTTP $CODE statt 404 (halb geöffneter Stream?)"
grep -q '"message"' /tmp/kube-logstream-404.json \
  || fail "logs/stream-404 ist keine saubere JSON-Antwort: $(cat /tmp/kube-logstream-404.json)"
pass "logs/stream auf unbekannten Cluster ergibt sauberes JSON 404 statt eines halb geöffneten Streams"

# Der eigentliche Verhaltens-Kern von carried requirement 1: der Body eines
# existierenden, aber unerreichbaren Clusters trägt wirklich ein
# type:error-SSE-Event. --max-time ist ein Sicherheitsnetz für den Fall
# eines Regressions-Hängers, nicht der Grund, warum die Verbindung endet
# (die endet, weil der Handler nach dem einen Event selbst res.end() ruft).
BODY=$(curl -sS -N --max-time 5 "${AUTH[@]}" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/logs/stream?namespace=default&pod=api")
echo "$BODY" | grep -q '"type":"error"' \
  || fail "logs/stream gegen einen unerreichbaren Cluster lieferte kein type:error-Event: $BODY"
pass "logs/stream gegen einen unerreichbaren Cluster liefert ein type:error SSE-Event"

# --- Review-Fund (Critical 1): ?token= ist der einzige Weg, wie ein Browser
#     (EventSource kann keine Header setzen) sich gegen die SSE-Route
#     authentifiziert. Braucht ein echtes JWT, kein API-Key — der Guard
#     liest ?token= nur, wenn KEIN Authorization-Header gesetzt ist. Ein
#     eigener Wegwerf-User statt des echten "admin"-Kontos: der ist in dieser
#     Umgebung deaktiviert (login liefert sonst "Konto ist deaktiviert"),
#     und ein Login-Passwort gehört ohnehin nicht in dieses Skript. Rolle
#     ist irrelevant — die Kube-Routen prüfen nur Auth, keine Rolle.
TEST_USER_PASSWORD="e2e-$(date +%s)-pw"
CREATED_USER=$(jq -n --arg u "e2e-kube-token-$$" --arg p "$TEST_USER_PASSWORD" '{username:$u, password:$p}' \
  | curl -sS "${AUTH[@]}" -X POST "${API_URL}/api/users" -d @-)
TEST_USER_ID=$(echo "$CREATED_USER" | jq -r '._id // empty')
TEST_USERNAME=$(echo "$CREATED_USER" | jq -r '.username // empty')
[ -n "$TEST_USER_ID" ] || fail "Wegwerf-User für den ?token=-Test konnte nicht angelegt werden: $CREATED_USER"

LOGIN=$(jq -n --arg u "$TEST_USERNAME" --arg p "$TEST_USER_PASSWORD" '{username:$u, password:$p}' \
  | curl -sS -H "Content-Type: application/json" -X POST "${API_URL}/api/auth/login" -d @-)
JWT=$(echo "$LOGIN" | jq -r '.accessToken // empty')
[ -n "$JWT" ] || fail "Login für den ?token=-Test fehlgeschlagen: $LOGIN"

# Ab hier bewusst OHNE ${AUTH[@]} — ein Authorization-Header würde den
# ?token=-Pfad im Guard nie betreten und der Test bewiese nichts.
CODE=$(curl -sS -o /tmp/kube-token.json -w '%{http_code}' -H "Content-Type: application/json" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/logs/stream?namespace=default&pod=api&token=${JWT}")
[ "$CODE" != "400" ] || fail "?token= wird von der ValidationPipe abgelehnt (forbidNonWhitelisted): $(cat /tmp/kube-token.json)"
[ "$CODE" != "401" ] || fail "?token= wird vom Guard nicht akzeptiert: $(cat /tmp/kube-token.json)"
pass "logs/stream akzeptiert ein gültiges ?token= ganz ohne Authorization-Header (HTTP $CODE)"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Content-Type: application/json" \
  "${API_URL}/api/kube-clusters/${CLUSTER_ID}/logs/stream?namespace=default&pod=api&token=garbage-not-a-jwt")
[ "$CODE" = "401" ] || fail "ein ungültiges ?token= ergab HTTP $CODE statt 401"
pass "logs/stream lehnt ein ungültiges ?token= mit 401 ab"

curl -sS -o /dev/null "${AUTH[@]}" -X DELETE "${API_URL}/api/users/${TEST_USER_ID}"
TEST_USER_ID=""

# --- 10. Löschen räumt auf -------------------------------------------------
curl -sS "${AUTH[@]}" -X DELETE "${API_URL}/api/kube-clusters/${CLUSTER_ID}" >/dev/null
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${API_URL}/api/kube-clusters/${CLUSTER_ID}")
[ "$CODE" = "404" ] || fail "Cluster nach DELETE noch da (HTTP $CODE)"
pass "DELETE entfernt den Cluster"
CLUSTER_ID=""

echo ""
echo "Kube cluster E2E: alle Prüfungen bestanden"
