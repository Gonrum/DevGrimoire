#!/usr/bin/env bash
# E2E-Test für Harness-Definitionen (M-51/H1, T-445).
#
# Deckt ab: alle drei Ebenen, Section-Upsert, Section-Delete, resolve,
# Mehrkunden-Reihenfolge, Tombstone — gegen den laufenden Server.
#
# Voraussetzung: laufender DevGrimoire-Stack mit Auth.
# Aufruf:
#   API_BASE=http://localhost:3200/api bash backend/test/harness-e2e.sh
#
# **Die globale Ebene wird bewusst nicht angefasst.** Sie ist ein Singleton und
# trägt nach der Migration die echten `agent_instructions`; ein Test, der sie
# überschreibt, zerstört Produktivdaten. Geprüft wird die Vererbung deshalb über
# Kunden- und Projektebene, die der Test selbst anlegt und wieder abräumt.
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl; need jq

API_KEY="${DEVGRIMOIRE_API_KEY:-$(grep -E '^DEVGRIMOIRE_API_KEY=' "$(git rev-parse --show-toplevel)/.env" | head -1 | cut -d= -f2-)}"
[[ -n "$API_KEY" ]] || fail "no DEVGRIMOIRE_API_KEY in env or .env"
AUTH=(-H "Authorization: Bearer $API_KEY")
JSON=(-H 'Content-Type: application/json')

# Eindeutiges Suffix pro Lauf: Kundennamen sind eindeutig, ein liegengebliebener
# Rest aus einem abgebrochenen Lauf würde den nächsten sonst mit 409 blockieren.
RUN_ID="$$-$(date +%s)"
PROJECT_ID=""
CUSTOMER_A=""
CUSTOMER_B=""

# Räumt auch bei Abbruch mitten im Lauf auf (`trap ... EXIT`). Reihenfolge:
# Harness-Ebenen, dann Projekt, dann Kunden — ein Kunde mit offener Verlinkung
# lässt sich sonst nicht löschen. Jeder Schritt ist einzeln fehlertolerant,
# damit ein bereits gelöschter Datensatz das Aufräumen nicht abbricht
# (`set -e` ist aktiv).
cleanup() {
  local id
  for q in "scope=project&projectId=$PROJECT_ID" "scope=customer&customerId=$CUSTOMER_A" "scope=customer&customerId=$CUSTOMER_B"; do
    [[ "$q" == *= ]] && continue
    id="$(curl -sS "${AUTH[@]}" "$API_BASE/harness?$q" 2>/dev/null | jq -r '._id // empty')" || true
    [[ -n "$id" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/harness/$id" >/dev/null 2>&1 || true
  done
  [[ -n "$PROJECT_ID" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/projects/$PROJECT_ID" >/dev/null 2>&1 || true
  for c in "$CUSTOMER_A" "$CUSTOMER_B"; do
    [[ -n "$c" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/customers/$c" >/dev/null 2>&1 || true
  done
  return 0
}
trap cleanup EXIT

# --- Testdaten anlegen ------------------------------------------------------

PROJECT_ID="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Harness Projekt $RUN_ID\"}" "$API_BASE/projects" | jq -r '._id')"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]] || fail "create project"
pass "Projekt $PROJECT_ID"

CUSTOMER_A="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Kunde A $RUN_ID\"}" "$API_BASE/customers" | jq -r '._id')"
CUSTOMER_B="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Kunde B $RUN_ID\"}" "$API_BASE/customers" | jq -r '._id')"
[[ -n "$CUSTOMER_A" && "$CUSTOMER_A" != "null" ]] || fail "create customer A"
[[ -n "$CUSTOMER_B" && "$CUSTOMER_B" != "null" ]] || fail "create customer B"
pass "Kunden $CUSTOMER_A / $CUSTOMER_B"

# Verlinkung: A zuerst, B danach — die Reihenfolge ist der Prüfgegenstand.
# Die Kunden-Id steht im Pfad, NICHT im Body (der DTO lehnt sie dort ab). Ein
# `>/dev/null` hier hätte den 400er verschluckt und den Test später an einer
# ganz anderen Stelle scheitern lassen — deshalb wird die Antwort geprüft.
link_customer() { # customerId
  local resp
  resp="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
    -d "{\"projectId\":\"$PROJECT_ID\"}" "$API_BASE/customers/$1/project-links")"
  echo "$resp" | jq -e '._id' >/dev/null 2>&1 || fail "Verlinkung mit Kunde $1: $resp"
}
link_customer "$CUSTOMER_A"
sleep 1
link_customer "$CUSTOMER_B"
pass "Projekt an beide Kunden verlinkt (A zuerst)"

# --- Sections auf zwei Ebenen ----------------------------------------------

set_section() { # scope owner-query key body strategy
  local resp
  resp="$(curl -sS -X PUT "${AUTH[@]}" "${JSON[@]}" \
    -d "{\"key\":\"$3\",\"kind\":\"prose\",\"title\":\"$3\",\"body\":\"$4\",\"mergeStrategy\":\"$5\",\"order\":10}" \
    "$API_BASE/harness/sections/$3?$2")"
  echo "$resp" | jq -e '._id' >/dev/null 2>&1 || fail "set_section $1/$3: $resp"
}

set_section customer "scope=customer&customerId=$CUSTOMER_A" regeln "A" append
set_section customer "scope=customer&customerId=$CUSTOMER_B" regeln "B" append
set_section project  "scope=project&projectId=$PROJECT_ID"   regeln "P" append
pass "Sections auf beiden Kundenebenen und der Projektebene gesetzt"

# --- resolve: Reihenfolge ---------------------------------------------------

RESOLVED="$(curl -sS "${AUTH[@]}" "$API_BASE/harness/resolve/$PROJECT_ID")"

# Die globale Ebene kann produktiv existieren (aus der Migration) und ist nicht
# Teil dessen, was dieser Test herstellt — geprüft wird der Rest der Kette.
CHAIN="$(echo "$RESOLVED" | jq -r '[.resolvedFrom[].scope] | map(select(. != "global")) | join(",")')"
[[ "$CHAIN" == "customer,customer,project" ]] || fail "Ebenen-Kette (ohne global): erwartet customer,customer,project — bekam '$CHAIN'"
pass "Ebenen-Kette ohne global: $CHAIN"

BODY="$(echo "$RESOLVED" | jq -r '.sections[] | select(.key=="regeln") | .body')"
EXPECTED=$'A\n\nB\n\nP'
[[ "$BODY" == "$EXPECTED" ]] || fail "Merge-Reihenfolge: erwartet 'A B P' — bekam $(echo "$BODY" | tr '\n' ' ')"
pass "Mehrkunden-Reihenfolge: A vor B (Verlinkungsreihenfolge), Projekt zuletzt"

ORIGIN="$(echo "$RESOLVED" | jq -r '[.sections[] | select(.key=="regeln") | .origin[].scope] | join(",")')"
[[ "$ORIGIN" == "customer,customer,project" ]] || fail "Herkunftspfad: $ORIGIN"
pass "Herkunftspfad wird ausgewiesen: $ORIGIN"

# --- Tombstone --------------------------------------------------------------

curl -sS -X PUT "${AUTH[@]}" "${JSON[@]}" \
  -d '{"key":"regeln","kind":"prose","enabled":false}' \
  "$API_BASE/harness/sections/regeln?scope=project&projectId=$PROJECT_ID" >/dev/null

SUPPRESSED="$(curl -sS "${AUTH[@]}" "$API_BASE/harness/resolve/$PROJECT_ID" | jq -r '[.suppressed[].key] | join(",")')"
[[ "$SUPPRESSED" == "regeln" ]] || fail "Tombstone nicht als suppressed ausgewiesen (bekam '$SUPPRESSED')"
STILL="$(curl -sS "${AUTH[@]}" "$API_BASE/harness/resolve/$PROJECT_ID" | jq -r '[.sections[].key] | join(",")')"
[[ "$STILL" != *regeln* ]] || fail "Tombstone-Section erscheint weiterhin im Ergebnis"
pass "Tombstone: Section verschwindet aus sections, taucht in suppressed auf"

# --- Section-Delete ---------------------------------------------------------

curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/harness/sections/regeln?scope=project&projectId=$PROJECT_ID" >/dev/null
AFTER="$(curl -sS "${AUTH[@]}" "$API_BASE/harness/resolve/$PROJECT_ID" | jq -r '.sections[] | select(.key=="regeln") | .body')"
[[ "$AFTER" == $'A\n\nB' ]] || fail "nach Delete der Projekt-Section: erwartet 'A B' — bekam $(echo "$AFTER" | tr '\n' ' ')"
pass "Section-Delete entfernt nur diese Ebene, die geerbte Fassung kommt zurück"

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "${AUTH[@]}" \
  "$API_BASE/harness/sections/gibtsnicht?scope=project&projectId=$PROJECT_ID")"
[[ "$STATUS" == "404" ]] || fail "Delete einer unbekannten Section: erwartet 404, bekam $STATUS"
pass "unbekannte Section löschen -> 404"

# --- Fehlerfälle ------------------------------------------------------------

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

[[ "$(code "${AUTH[@]}" "$API_BASE/harness")" == "400" ]] || fail "fehlender scope sollte 400 sein"
[[ "$(code "${AUTH[@]}" "$API_BASE/harness?scope=unsinn")" == "400" ]] || fail "unbekannter scope sollte 400 sein"
[[ "$(code "${AUTH[@]}" "$API_BASE/harness/resolve/nicht-hex")" == "400" ]] || fail "ungültige Id sollte 400 sein (nicht 500)"
[[ "$(code "${AUTH[@]}" "$API_BASE/harness/resolve/000000000000000000000000")" == "404" ]] || fail "unbekanntes Projekt sollte 404 sein"
[[ "$(code -X PUT "${AUTH[@]}" "${JSON[@]}" -d '{"key":"ton","kind":"prose"}' "$API_BASE/harness/sections/stil?scope=project&projectId=$PROJECT_ID")" == "400" ]] \
  || fail "Key-Mismatch Pfad/Body sollte 400 sein"
[[ "$(code -X PUT "${AUTH[@]}" "${JSON[@]}" -d '{"key":"x","kind":"quatsch"}' "$API_BASE/harness/sections/x?scope=project&projectId=$PROJECT_ID")" == "400" ]] \
  || fail "ungültiges kind sollte 400 sein"
pass "Fehlerfälle: 400/404 statt 500"

# --- leere Ebene ------------------------------------------------------------

EMPTY="$(curl -sS "${AUTH[@]}" "$API_BASE/harness?scope=customer&customerId=000000000000000000000000")"
[[ "$EMPTY" == "{}" ]] || fail "nicht existierende Ebene sollte {} liefern, bekam '$EMPTY'"
pass "nicht existierende Ebene liefert {} (kein leerer Body)"

# --- Migration: zweimal laufen lassen ---------------------------------------
#
# Der eigentliche Prüfgegenstand ist Idempotenz: der ZWEITE Lauf muss null
# Sections schreiben. Auf einer bereits migrierten Datenbank schreibt auch der
# erste nichts — die Aussage bleibt dieselbe.
#
# Die Migration spricht MongoDB direkt an, nicht über die API. Der Hostname aus
# der `.env` (`mongodb`) gilt nur im Compose-Netz; vom Host aus ist der Port
# veröffentlicht. Deshalb die Umschreibung — schlägt die Verbindung trotzdem
# fehl, wird der Schritt sichtbar übersprungen statt still zu verschwinden.
ROOT="$(git rev-parse --show-toplevel)"
MIGRATE_URI="${MONGODB_URI:-$(grep -E '^MONGODB_URI=' "$ROOT/.env" | head -1 | cut -d= -f2- | sed 's|@mongodb:|@localhost:|')}"

if [[ -z "$MIGRATE_URI" ]]; then
  echo "SKIP: Migrations-Doppellauf — keine MONGODB_URI gefunden"
else
  run_migration() { MONGODB_URI="$MIGRATE_URI" node "$ROOT/backend/scripts/harness-migrate.cjs" 2>&1; }
  if ! FIRST="$(run_migration)"; then
    echo "SKIP: Migrations-Doppellauf — MongoDB von hier nicht erreichbar"
    echo "      (im Container: docker compose exec backend ... , oder MONGODB_URI setzen)"
  else
    SECOND="$(run_migration)"
    WRITTEN="$(echo "$SECOND" | grep -oP 'Sections geschrieben\s*:\s*\K[0-9]+' | head -1)"
    [[ "$WRITTEN" == "0" ]] || fail "Migration nicht idempotent: zweiter Lauf schrieb $WRITTEN Sections"
    SOULS_BEFORE="$(echo "$FIRST" | grep -oP 'Souls\s*:\s*\K[0-9]+' | head -1)"
    SOULS_AFTER="$(echo "$SECOND" | grep -oP 'Souls\s*:\s*\K[0-9]+' | head -1)"
    [[ "$SOULS_BEFORE" == "$SOULS_AFTER" ]] || fail "Soul-Collection verändert: $SOULS_BEFORE -> $SOULS_AFTER"
    pass "Migration idempotent: zweiter Lauf schreibt 0 Sections, Soul-Collection unverändert ($SOULS_AFTER)"
  fi
fi

echo
echo "Alle Harness-E2E-Prüfungen bestanden."
