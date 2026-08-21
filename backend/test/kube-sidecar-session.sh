#!/usr/bin/env bash
# E2E für den Kube-Session-Endpunkt des Sidecars (K3, Task 2).
# Läuft gegen den laufenden workspace-Container.
#
# SIDECAR_URL: der `workspace`-Service published in docker-compose.yml
# KEINEN Host-Port (nur `workspace-net`/`workspace-api-net`, letzteres
# `internal: true`). Der Default unten (http://localhost:9000) funktioniert
# deshalb nicht unverändert von einer Host-Shell aus. Override mit der
# Container-IP, z.B.:
#   IP=$(docker inspect devgrimoire-workspace --format \
#     '{{(index .NetworkSettings.Networks "devgrimoire_workspace-api-net").IPAddress}}')
#   SIDECAR_URL="http://$IP:9000" ./backend/test/kube-sidecar-session.sh
# Der Host erreicht diese IP trotz `internal: true`, weil die Bridge lokal
# am Host hängt. Läuft dieses Skript dagegen aus einem Container heraus, der
# selbst an workspace-api-net hängt (z.B. dem Backend), reicht der Default.
set -euo pipefail

TOKEN="${WORKSPACE_API_TOKEN:?WORKSPACE_API_TOKEN muss gesetzt sein (aus .env)}"
BASE="${SIDECAR_URL:-http://localhost:9000}"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

# Läuft garantiert beim Skriptende, auch wenn ein früherer Check via fail()
# (exit 1) das Skript vorzeitig beendet — ein Leak-Check, der nur bei einem
# sauberen Gesamtdurchlauf feuert, ist kein Leak-Check. Muss darum per EXIT-
# Trap früh registriert werden, nicht als letzte Zeile im Happy Path.
canary_check_on_exit() {
  local prior_rc=$?
  trap - EXIT
  if docker logs devgrimoire-workspace 2>&1 | grep -q "SIDECAR_CANARY_TOKEN"; then
    echo "✗ der Kubeconfig-Token steht im Sidecar-Log" >&2
    exit 1
  fi
  if [ "$prior_rc" = "0" ]; then
    echo "✓ kein Credential im Sidecar-Log"
    echo ""
    echo "Kube sidecar session E2E: alle Prüfungen bestanden"
  fi
  exit "$prior_rc"
}
trap canary_check_on_exit EXIT

KC='apiVersion: v1
kind: Config
current-context: t
contexts: [{name: t, context: {cluster: c, user: u}}]
clusters: [{name: c, cluster: {server: "https://example.invalid:6443"}}]
users: [{name: u, user: {token: SIDECAR_CANARY_TOKEN}}]'

# --- 1. Session anlegen ---------------------------------------------------
RESP=$(jq -n --arg kc "$KC" '{kubeconfig: $kc, ttlSeconds: 120}' \
  | curl -sS "${AUTH[@]}" -X POST "${BASE}/kube/session" -d @-)
SID=$(echo "$RESP" | jq -r '.kubeSessionId')
[ "$SID" != "null" ] && [ -n "$SID" ] || fail "keine kubeSessionId: $RESP"
pass "Session angelegt ($SID)"

# --- 2. Datei liegt im tmpfs, Modus 0600, nur für den Sidecar-User -------
MODE=$(docker exec devgrimoire-workspace stat -c '%a %U' "/run/kube-sessions/${SID}.yaml" 2>/dev/null || echo "fehlt")
[ "$MODE" = "600 workspace" ] || fail "Kubeconfig-Datei hat Modus/Owner '$MODE', erwartet '600 workspace'"
pass "Kubeconfig liegt mit 0600 beim Sidecar-User"

MOUNT=$(docker exec devgrimoire-workspace sh -c "df --output=fstype /run/kube-sessions | tail -1" 2>/dev/null | tr -d ' ')
[ "$MOUNT" = "tmpfs" ] || fail "/run/kube-sessions ist '$MOUNT', kein tmpfs — die Config überlebte einen Neustart"
pass "/run/kube-sessions ist ein tmpfs"

# --- 3. kubectl ist da und nutzt die Session-Config -----------------------
VER=$(docker exec devgrimoire-workspace kubectl version --client -o json 2>/dev/null | jq -r '.clientVersion.gitVersion')
[ -n "$VER" ] && [ "$VER" != "null" ] || fail "kubectl fehlt im Sidecar-Image"
pass "kubectl vorhanden ($VER)"

CTX=$(docker exec -e KUBECONFIG="/run/kube-sessions/${SID}.yaml" devgrimoire-workspace \
  kubectl config current-context 2>/dev/null || true)
[ "$CTX" = "t" ] || fail "kubectl liest die Session-Config nicht (current-context='$CTX')"
pass "kubectl liest die Session-Kubeconfig"

# --- 4. Unbekannte Session wird abgelehnt --------------------------------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "${BASE}/kube/session" -d '{}')
[ "$CODE" = "400" ] || fail "leerer Body ergab HTTP $CODE statt 400"
pass "leerer Body wird mit 400 abgelehnt"

# --- 5. Ohne Bearer kein Zugriff -----------------------------------------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/kube/session" \
  -H 'Content-Type: application/json' -d '{"kubeconfig":"x"}')
[ "$CODE" = "401" ] || fail "ohne Bearer ergab HTTP $CODE statt 401"
pass "ohne Bearer 401"

# --- 6a. /kube/exec: args als String statt Array -> 400 -------------------
# Das ist die Grenze, die aus "freies kubectl" keine "freie Shell" werden lässt.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -X POST "${BASE}/kube/exec" \
  -d "{\"kubeSessionId\":\"$SID\",\"args\":\"get pods; id\"}")
[ "$CODE" = "400" ] || fail "args als String ergab HTTP $CODE statt 400"
pass "args muss ein Array sein"

# --- 6b. /kube/exec: unbekannte Session -> 404 -----------------------------
# Session-IDs sind 32 rohe Hex-Zeichen (crypto.randomBytes(16).toString('hex')),
# keine gestrichelte UUID — sonst greift schon die Format-Prüfung (400) statt
# der eigentlich getesteten "unbekannt, aber wohlgeformt"-Prüfung (404).
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -X POST "${BASE}/kube/exec" \
  -d '{"kubeSessionId":"00000000000000000000000000000000","args":["version"]}')
[ "$CODE" = "404" ] || fail "unbekannte Session ergab HTTP $CODE statt 404"
pass "unbekannte Session ergibt 404"

# --- 6c. /kube/exec: kubectl läuft und sieht die Session-Kubeconfig -------
OUT=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -X POST "${BASE}/kube/exec" \
  -d "{\"kubeSessionId\":\"$SID\",\"args\":[\"config\",\"current-context\"]}")
echo "$OUT" | jq -e '.exitCode == 0' >/dev/null || fail "kubectl config current-context: $OUT"
pass "kubectl läuft mit der Session-Kubeconfig"

# --- 6d. /kube/exec: kein Shell-Escape über ein einzelnes Argument --------
# 6a prüft nur `Array.isArray`, nicht die Abwesenheit einer Shell — vertauschte
# man execFile gegen exec([...].join(' ')), bliebe 6a grün und
# args: ["get","pods;id"] würde zur Injektion. Dieser Check fängt genau das:
# ein Semikolon in EINEM Argument bleibt Text für kubectl, wird nie zur
# Kommando-Trennung. Liefe stattdessen `id` als zweiter Befehl, stünde
# "uid=" in der Ausgabe.
OUT=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -X POST "${BASE}/kube/exec" \
  -d "{\"kubeSessionId\":\"$SID\",\"args\":[\"get\",\"pods;id\"]}")
if echo "$OUT" | grep -qE 'uid=[0-9]+\(' ; then
  fail "Shell-Metazeichen im Argument wurden ausgeführt: $OUT"
fi
pass "Semikolon im Argument bleibt Text, keine Kommando-Injektion"

# --- 7. Löschen ist idempotent -------------------------------------------
curl -sS -o /dev/null "${AUTH[@]}" -X DELETE "${BASE}/kube/session/${SID}"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X DELETE "${BASE}/kube/session/${SID}")
[ "$CODE" = "204" ] || fail "zweites DELETE ergab HTTP $CODE statt 204"
GONE=$(docker exec devgrimoire-workspace sh -c "test -f /run/kube-sessions/${SID}.yaml && echo da || echo weg")
[ "$GONE" = "weg" ] || fail "Kubeconfig-Datei überlebte das DELETE"
pass "DELETE ist idempotent und entfernt die Datei"

# Restlicher Output (Canary-Check + Abschlussbanner) kommt aus dem EXIT-Trap
# oben — der muss so oder so laufen, auch wenn ein früherer Check via fail()
# das Skript vorzeitig beendet.
