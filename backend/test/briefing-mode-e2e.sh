#!/usr/bin/env bash
# E2E-Test für den Briefing-Mode (M-49, T-416).
#
# Treibt `milestone_create_with_todos` über den **echten** Chat-Tool-Pfad
# (`POST /chat/sessions/:id/tools/execute`) — ohne LLM. Das ist Absicht: das
# lokale Modell läuft mit 4 Token/s und setzt einen Tool-Call nicht garantiert
# ab. Ein Test, der davon abhängt, ist kein Test, sondern ein Glücksspiel.
#
# Der Live-Durchstich (Modell → tool_confirm → Bestätigung → Milestone) ist
# separat gefahren und im Todo dokumentiert; er ersetzt diesen Test nicht,
# sondern ergänzt ihn.
#
# Aufruf:
#   API_BASE=http://localhost:3200/api bash backend/test/briefing-mode-e2e.sh
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

RUN_ID="$$-$(date +%s)"
PROJECT=""
SESSION=""

cleanup() {
  [[ -n "$SESSION" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/chat/sessions/$SESSION" >/dev/null 2>&1 || true
  [[ -n "$PROJECT" ]] && curl -sS -X DELETE "${AUTH[@]}" "$API_BASE/projects/$PROJECT" >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

PROJECT="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"name\":\"E2E Briefing $RUN_ID\"}" "$API_BASE/projects" | jq -r '._id')"
[[ -n "$PROJECT" && "$PROJECT" != "null" ]] || fail "create project"
SESSION="$(curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"projectId\":\"$PROJECT\",\"title\":\"E2E Briefing\"}" "$API_BASE/chat/sessions" | jq -r '._id')"
[[ -n "$SESSION" && "$SESSION" != "null" ]] || fail "create chat session"
pass "Projekt $PROJECT / Session $SESSION"

# Ruft ein Tool über den echten Chat-Pfad auf und gibt die Antwort zurück.
exec_tool() { # args-json
  jq -n --arg p "$PROJECT" --argjson a "$1" \
    '{name: "milestone_create_with_todos", projectId: $p, arguments: $a}' \
    | curl -sS -X POST "${AUTH[@]}" "${JSON[@]}" -d @- "$API_BASE/chat/sessions/$SESSION/tools/execute"
}

# --- Der Normalfall: strukturierte Felder kommen an -------------------------

RES="$(exec_tool '{
  "name": "Briefing-Ergebnis",
  "description": "Aus einem Briefing entstanden.",
  "todos": [
    {"title": "Mit allem", "priority": "high", "tags": ["a","b"],
     "userStories": "Als Nutzer will ich X.",
     "acceptanceCriteria": [{"text": "Kriterium eins"}, {"text": "Kriterium zwei"}],
     "outOfScope": "Nicht dies.", "edgeCases": "Ein Randfall."},
    {"title": "Nur Titel"}
  ]}')"
[[ "$(jq -r '.success' <<<"$RES")" == "true" ]] || fail "Tool-Aufruf fehlgeschlagen: $RES"
pass "milestone_create_with_todos über den Chat-Tool-Pfad"

MS_COUNT="$(curl -sS "${AUTH[@]}" "$API_BASE/milestones?projectId=$PROJECT" | jq -r 'length')"
[[ "$MS_COUNT" == "1" ]] || fail "erwartet 1 Milestone, gefunden $MS_COUNT"
TODOS="$(curl -sS "${AUTH[@]}" "$API_BASE/todos?projectId=$PROJECT&limit=10")"
[[ "$(jq -r 'length' <<<"$TODOS")" == "2" ]] || fail "erwartet 2 Todos"
pass "Milestone + 2 Todos angelegt"

FULL="$(jq -r '[.[] | select(.title=="Mit allem")][0]' <<<"$TODOS")"
[[ "$(jq -r '.priority' <<<"$FULL")" == "high" ]] || fail "Priorität kam nicht an"
[[ "$(jq -r '.tags | length' <<<"$FULL")" == "2" ]] || fail "Tags kamen nicht an"
[[ "$(jq -r '.acceptanceCriteria | length' <<<"$FULL")" == "2" ]] || fail "Akzeptanzkriterien kamen nicht an"
[[ "$(jq -r '.userStories' <<<"$FULL")" == *"Als Nutzer"* ]] || fail "User Stories kamen nicht an"
[[ "$(jq -r '.outOfScope' <<<"$FULL")" == *"Nicht dies"* ]] || fail "outOfScope kam nicht an"
pass "die strukturierten Felder kommen vollständig an"

MINIMAL="$(jq -r '[.[] | select(.title=="Nur Titel")][0]' <<<"$TODOS")"
[[ "$(jq -r '.status' <<<"$MINIMAL")" == "open" ]] || fail "Todo ohne Felder bekam keinen Default-Status"
pass "ein Todo mit nur einem Titel wird angelegt (Defaults greifen)"

# --- Edge Cases -------------------------------------------------------------

# Der Vertrag ist **Teil-Erfolg mit Warnungen**, nicht Alles-oder-nichts: der
# Milestone entsteht, ein unbrauchbares Todo wird uebersprungen und in
# `warnings[]` gemeldet. Das ist die schaerfere Zusicherung — ein Test auf
# `success == false` haette hier das Falsche geprueft (und tat es zunaechst).

EMPTY="$(exec_tool '{"name": "Ohne Todos", "todos": []}')"
[[ "$(jq -r '.success' <<<"$EMPTY")" == "true" ]] || fail "leere Todo-Liste sollte durchgehen: $EMPTY"
[[ "$(jq -r '.result.todos | length' <<<"$EMPTY")" == "0" ]] || fail "leere Liste erzeugte Todos"
pass "leere Todo-Liste: Milestone ohne Todos, keine Warnung"

NO_TITLE="$(exec_tool '{"name": "Titelloses", "todos": [{"description": "ohne Titel"}]}')"
[[ "$(jq -r '.result.todos | length' <<<"$NO_TITLE")" == "0" ]] || fail "titelloses Todo wurde angelegt"
jq -e '.result.warnings[]? | select(test("title"))' <<<"$NO_TITLE" >/dev/null   || fail "kein Hinweis auf den fehlenden Titel: $(jq -c '.result.warnings' <<<"$NO_TITLE")"
pass "Todo ohne Titel: nicht angelegt, als Warnung gemeldet"

BAD_PRIO="$(exec_tool '{"name": "Falsche Prio", "todos": [{"title": "X", "priority": "ultra"}]}')"
[[ "$(jq -r '.result.todos | length' <<<"$BAD_PRIO")" == "0" ]] || fail "Todo mit Unsinns-Prioritaet wurde angelegt"
jq -e '.result.warnings[]? | select(test("priority"))' <<<"$BAD_PRIO" >/dev/null   || fail "kein Hinweis auf die unbekannte Prioritaet"
pass "unbekannte Priorität: nicht still auf medium gesetzt, sondern gemeldet"

NO_NAME="$(exec_tool '{"todos": [{"title": "X"}]}')"
[[ "$(jq -r '.success' <<<"$NO_NAME")" == "false" ]] || fail "Milestone ohne Namen sollte abgelehnt werden"
[[ "$(jq -r '.error' <<<"$NO_NAME")" == *"name"* ]] || fail "Fehlermeldung nennt das fehlende Feld nicht"
pass "Milestone ohne Namen: abgelehnt, Meldung nennt das Feld"

# Nach den vier Fehlerfaellen darf kein zusaetzlicher Milestone entstanden sein.
# Vier Aufrufe, drei davon mit Milestone-Namen -> 1 (Normalfall) + 3 = 4.
# Der namenlose Aufruf darf nichts hinterlassen haben.
FINAL_MS="$(curl -sS "${AUTH[@]}" "$API_BASE/milestones?projectId=$PROJECT" | jq -r 'length')"
[[ "$FINAL_MS" == "4" ]] || fail "erwartet 4 Milestones (1 + 3 mit Namen), gefunden $FINAL_MS"
pass "der namenlose Aufruf hinterlaesst nichts ($FINAL_MS Milestones wie erwartet)"

FINAL_TODOS="$(curl -sS "${AUTH[@]}" "$API_BASE/todos?projectId=$PROJECT&limit=50" | jq -r 'length')"
[[ "$FINAL_TODOS" == "2" ]] || fail "erwartet 2 Todos (nur die gueltigen), gefunden $FINAL_TODOS"
pass "kein Todo aus den Fehlerfaellen ist durchgerutscht ($FINAL_TODOS)"

echo
echo "Alle Briefing-Mode-E2E-Prüfungen bestanden."
