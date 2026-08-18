#!/usr/bin/env bash
# E2E-Test für den Export/Import-Zyklus eines Milestones (M-49, T-409).
#
# Der Kern ist der **Rundlauf**: exportieren, den erzeugten Markdown wieder
# parsen, importieren und mit dem Original vergleichen. Bricht der Parser bei
# etwas, das der eigene Export erzeugt hat, ist das Format in sich
# widersprüchlich — und genau das würde im Betrieb erst auffallen, wenn jemand
# einen echten Milestone verliert.
#
# Voraussetzung: laufender DevGrimoire-Stack mit Auth.
# Aufruf:
#   API_BASE=http://localhost:3200/api bash backend/test/milestone-transfer-e2e.sh
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
skip() { echo "SKIP: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing binary: $1"; }
need curl; need jq

API_KEY="${DEVGRIMOIRE_API_KEY:-$(grep -E '^DEVGRIMOIRE_API_KEY=' "$(git rev-parse --show-toplevel)/.env" | head -1 | cut -d= -f2-)}"
[[ -n "$API_KEY" ]] || fail "no DEVGRIMOIRE_API_KEY in env or .env"
AUTH=(-H "Authorization: Bearer $API_KEY")
JSON=(-H 'Content-Type: application/json')

RUN_ID="$$-$(date +%s)"
SRC_PROJECT=""
DST_PROJECT=""

# Räumt bei jedem Ausgang auf. Projekte löschen kaskadiert auf Milestones und
# Todos, deshalb reicht das Projekt.
cleanup() {
  for p in "$SRC_PROJECT" "$DST_PROJECT"; do
    [[ -n "$p" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/projects/$p" >/dev/null 2>&1 || true
  done
  return 0
}
trap cleanup EXIT

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

# --- Quelle aufbauen --------------------------------------------------------

SRC_PROJECT="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Transfer Quelle $RUN_ID\"}" "$API_BASE/projects" | jq -r '._id')"
DST_PROJECT="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Transfer Ziel $RUN_ID\"}" "$API_BASE/projects" | jq -r '._id')"
[[ "$SRC_PROJECT" != "null" && -n "$SRC_PROJECT" ]] || fail "create source project"
[[ "$DST_PROJECT" != "null" && -n "$DST_PROJECT" ]] || fail "create target project"
pass "Projekte $SRC_PROJECT / $DST_PROJECT"

MS="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d "{
  \"projectId\":\"$SRC_PROJECT\",
  \"name\":\"Transfer-Probe\",
  \"description\":\"Beschreibung mit **Markdown** und einer Zeile mehr.\"
}" "$API_BASE/milestones" | jq -r '._id')"
[[ -n "$MS" && "$MS" != "null" ]] || fail "create milestone"

# Zwei Todos, eines mit allen strukturierten Feldern — genau die gingen beim
# Projekt-Import früher verloren (M-52), hier ist der Wächter dafür.
T1="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d "{
  \"projectId\":\"$SRC_PROJECT\", \"milestoneId\":\"$MS\",
  \"title\":\"Erstes Todo\", \"description\":\"Eine Beschreibung.\",
  \"priority\":\"high\", \"tags\":[\"alpha\",\"beta\"],
  \"userStories\":\"Als Nutzer will ich X.\",
  \"acceptanceCriteria\":[{\"text\":\"Kriterium eins\"},{\"text\":\"Kriterium zwei\"}],
  \"outOfScope\":\"Nicht Teil davon.\", \"edgeCases\":\"Ein Randfall.\"
}" "$API_BASE/todos" | jq -r '._id')"
curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d "{
  \"projectId\":\"$SRC_PROJECT\", \"milestoneId\":\"$MS\", \"title\":\"Zweites Todo\"
}" "$API_BASE/todos" >/dev/null
[[ -n "$T1" && "$T1" != "null" ]] || fail "create todo"
pass "Milestone mit 2 Todos angelegt"

# --- Export -----------------------------------------------------------------

MD="$(curl -sS "${AUTH[@]}" "$API_BASE/milestones/$MS/export.md")"
[[ -n "$MD" ]] || fail "Export ist leer"
grep -q "Transfer-Probe" <<<"$MD" || fail "Export enthält den Milestone-Namen nicht"
grep -q "Erstes Todo" <<<"$MD" || fail "Export enthält das erste Todo nicht"
grep -q "Kriterium eins" <<<"$MD" || fail "Export enthält die Akzeptanzkriterien nicht"
pass "Export enthält Name, Todos und strukturierte Felder"

# --- Rundlauf: den eigenen Export wieder parsen -----------------------------

PARSED="$(jq -n --arg md "$MD" '{markdown: $md}' \
  | curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/preview")"

PARSED_NAME="$(jq -r '.name' <<<"$PARSED")"
PARSED_COUNT="$(jq -r '.todos | length' <<<"$PARSED")"
[[ "$PARSED_NAME" == *"Transfer-Probe"* ]] || fail "Parser verliert den Namen: '$PARSED_NAME'"
[[ "$PARSED_COUNT" == "2" ]] || fail "Parser findet $PARSED_COUNT statt 2 Todos"
pass "Rundlauf: der eigene Export ist wieder parsebar ($PARSED_COUNT Todos)"

FIRST="$(jq -r '.todos[0]' <<<"$PARSED")"
[[ "$(jq -r '.title' <<<"$FIRST")" == "Erstes Todo" ]] || fail "Titel im Rundlauf verloren"
[[ "$(jq -r '.priority' <<<"$FIRST")" == "high" ]] || fail "Priorität im Rundlauf verloren"
[[ "$(jq -r '.acceptanceCriteria | length' <<<"$FIRST")" == "2" ]] || fail "Akzeptanzkriterien im Rundlauf verloren"
[[ "$(jq -r '.userStories' <<<"$FIRST")" == *"Als Nutzer"* ]] || fail "User Stories im Rundlauf verloren"
pass "strukturierte Felder überstehen den Rundlauf (Priorität, Kriterien, User Stories)"

# --- Import ins Zielprojekt -------------------------------------------------

IMPORTED="$(jq -n --arg p "$DST_PROJECT" --argjson parsed "$PARSED" '{projectId: $p, parsed: $parsed}' \
  | curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/apply")"
NEW_MS="$(jq -r '.milestone._id' <<<"$IMPORTED")"
NEW_COUNT="$(jq -r '.todos | length' <<<"$IMPORTED")"
[[ -n "$NEW_MS" && "$NEW_MS" != "null" ]] || fail "Import legte keinen Milestone an: $IMPORTED"
[[ "$NEW_COUNT" == "2" ]] || fail "Import legte $NEW_COUNT statt 2 Todos an"
pass "Import ins Zielprojekt: Milestone + $NEW_COUNT Todos"

IMPORTED_FIRST="$(curl -sS "${AUTH[@]}" "$API_BASE/todos?projectId=$DST_PROJECT&limit=10" \
  | jq -r '[.[] | select(.title=="Erstes Todo")][0]')"
[[ "$(jq -r '.acceptanceCriteria | length' <<<"$IMPORTED_FIRST")" == "2" ]] \
  || fail "Akzeptanzkriterien kamen beim Import nicht an"
[[ "$(jq -r '.priority' <<<"$IMPORTED_FIRST")" == "high" ]] || fail "Priorität kam beim Import nicht an"
pass "die importierten Todos tragen ihre strukturierten Felder"

# --- Anwenden: Todo über die State-Machine schliessen ------------------------

IMP_T1="$(jq -r '._id' <<<"$IMPORTED_FIRST")"
# Der echte Pfad geht Schritt für Schritt — ein Sprung direkt auf `done` wird
# abgelehnt und pruefte etwas anderes als der Nutzer erlebt.
for st in in_progress review done; do
  curl -sS -X PUT "${AUTH[@]}" "${JSON[@]}" -d "{\"status\":\"$st\"}" "$API_BASE/todos/$IMP_T1" >/dev/null
done
FINAL="$(curl -sS "${AUTH[@]}" "$API_BASE/todos/$IMP_T1" | jq -r '.status')"
[[ "$FINAL" == "done" ]] || fail "Todo liess sich nicht schliessen (Status: $FINAL)"
pass "Anwenden-Schritt: Todo über die State-Machine auf done"

# `done -> open` ist ERLAUBT: der Code hat dafuer eine ausdrueckliche Ausnahme
# ("Allow reopening"). Ein Test, der hier 400 erwartet, prueft die Zusammen-
# fassung in CLAUDE.md statt das Verhalten — genau das ist mir hier passiert.
REOPEN="$(code -X PUT "${AUTH[@]}" "${JSON[@]}" -d '{"status":"open"}' "$API_BASE/todos/$IMP_T1")"
[[ "$REOPEN" == "200" ]] || fail "Wiedereroeffnen (done -> open) sollte erlaubt sein, war $REOPEN"
pass "State-Machine erlaubt das Wiedereroeffnen (done -> open)"

# Ein echter Sprung muss dagegen abgelehnt werden.
JUMP="$(code -X PUT "${AUTH[@]}" "${JSON[@]}" -d '{"status":"done"}' "$API_BASE/todos/$IMP_T1")"
[[ "$JUMP" == "400" ]] || fail "Sprung open -> done sollte 400 sein, war $JUMP"
pass "State-Machine lehnt echte Spruenge ab (open -> done = 400)"

# --- Edge Cases -------------------------------------------------------------

EMPTY="$(jq -n '{markdown: ""}' | curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/preview" -w '\n%{http_code}')"
EMPTY_CODE="$(tail -1 <<<"$EMPTY")"
[[ "$EMPTY_CODE" == "200" || "$EMPTY_CODE" == "400" ]] || fail "leeres Markdown ergab $EMPTY_CODE (kein 500 erwartet)"
pass "leeres Markdown: $EMPTY_CODE, kein Serverfehler"

NOISE="$(jq -n '{markdown: "nur eine Zeile ohne jede Struktur\n\nund noch eine"}' \
  | curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/preview")"
NOISE_TODOS="$(jq -r '.todos | length' <<<"$NOISE")"
[[ "$NOISE_TODOS" == "0" ]] || fail "strukturloses Markdown ergab $NOISE_TODOS Todos statt 0"
pass "strukturloses Markdown ergibt 0 Todos statt erfundener"

BAD_PROJECT="$(jq -n --argjson parsed "$PARSED" '{projectId: "000000000000000000000000", parsed: $parsed}' \
  | code -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/apply")"
[[ "$BAD_PROJECT" == "400" || "$BAD_PROJECT" == "404" ]] || fail "Import in unbekanntes Projekt ergab $BAD_PROJECT"
pass "Import in ein unbekanntes Projekt: $BAD_PROJECT"

NOT_HEX="$(jq -n --argjson parsed "$PARSED" '{projectId: "nicht-hex", parsed: $parsed}' \
  | code -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/import/apply")"
[[ "$NOT_HEX" == "400" ]] || fail "Import mit ungültiger Id ergab $NOT_HEX statt 400"
pass "Import mit ungültiger projectId: 400 (kein CastError-500)"

# --- KI-Schritt: nur wenn ein Chat-Endpunkt antwortet -----------------------

AI_CODE="$(jq -n '{summaryMarkdown: "## Erledigt\n- Erstes Todo ist fertig."}' \
  | code -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/milestones/$MS/ai-complete")"
if [[ "$AI_CODE" == "200" ]]; then
  pass "ai-complete antwortet (200)"
else
  # Bewusst kein Fehlschlag: ohne erreichbaren Chat-Endpunkt ist der Schritt
  # nicht fahrbar. Sichtbar uebersprungen statt still ausgelassen.
  skip "ai-complete nicht fahrbar (HTTP $AI_CODE) — kein erreichbarer Chat-Endpunkt"
fi

echo
echo "Alle Export/Import-E2E-Prüfungen bestanden."
