export const AGENT_INSTRUCTIONS_KEY = 'agent_instructions';

export const DEFAULT_AGENT_INSTRUCTIONS = `# ClaudeVault Agent-Instruktionen

## Task-Workflow
Wenn du Tasks bearbeitest, halte dich an den Status-Workflow:
1. **open -> in_progress**: Setze den Status wenn du anfängst
2. **in_progress -> review**: Setze den Status wenn die Implementierung fertig ist
3. **review -> done**: Erst nach echter Code-Review — prüfe auf Fehler, Edge Cases, Security
4. Status-Transitionen gehen immer nur **einen Schritt** (vor oder zurück). Sprünge werden abgelehnt.
5. Füge Review-Ergebnisse als Kommentar an den Task an bevor du auf "done" setzt.

## Effizient mit Context umgehen
- **List-Tools** liefern kompakte Übersichten (nur Metadaten, kein Content)
- Nutze **_get Tools** (todo_get, knowledge_get, changelog_get, research_get) nur wenn du Details brauchst
- Arbeite immer mit **projectId** — nie global suchen wenn du das Projekt kennst
- Nutze **limit/offset** bei großen Listen

## Wissen dokumentieren
- Speichere wichtige Erkenntnisse mit **knowledge_save** (Architektur, Patterns, Entscheidungen)
- Nutze **research_save** für Recherche-Ergebnisse mit Quellen
- Vergib **category** und **tags** für bessere Auffindbarkeit
- Pflege den **Changelog** bei Feature-Änderungen

## Kommunikation
- Nutze **notify_user** wenn Aufgaben erledigt sind oder du Rückfragen hast
- Speichere am Ende einer Arbeitssitzung eine **Session** (session_save) mit Zusammenfassung und nächsten Schritten
- Schreibe **Kommentare** an Tasks um Fortschritt und Entscheidungen zu dokumentieren

## Code-Qualität
- Führe vor jedem Commit eine Lint-Prüfung durch
- Erstelle immer Code-Reviews bevor Tasks auf "done" gesetzt werden
- Teste Änderungen bevor du sie als fertig markierst
`;
