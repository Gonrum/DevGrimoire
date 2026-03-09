import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

const DEFAULT_INSTRUCTIONS = `# ClaudeVault Agent-Instruktionen

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

export default function Settings() {
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.settings.get('agent_instructions');
      setInstructions(res.value ?? DEFAULT_INSTRUCTIONS);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.settings.set('agent_instructions', instructions);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setInstructions(DEFAULT_INSTRUCTIONS);
    setSaved(false);
  };

  if (loading) {
    return <div className="text-gray-500 py-10 text-center">Laden...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Einstellungen</h1>
      <p className="text-gray-400 mb-6">
        Globale Instruktionen die jeder Agent beim Start einer Session erh&auml;lt.
        Agents rufen <code className="text-blue-400 bg-gray-800 px-1 rounded">system_instructions_get</code> auf
        und verhalten sich entsprechend.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800/50">
          <span className="text-sm text-gray-400 font-medium">Agent-Instruktionen (Markdown)</span>
          <div className="flex items-center gap-2">
            {!saved && (
              <span className="text-xs text-yellow-500">Ungespeicherte &Auml;nderungen</span>
            )}
          </div>
        </div>
        <textarea
          value={instructions}
          onChange={(e) => { setInstructions(e.target.value); setSaved(false); }}
          className="w-full h-[500px] bg-gray-900 text-gray-200 px-4 py-3 font-mono text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={saving || saved}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          {saving ? 'Speichern...' : 'Speichern'}
        </button>
        <button
          onClick={reset}
          className="px-4 py-2 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 transition-colors text-sm"
        >
          Auf Standard zur&uuml;cksetzen
        </button>
      </div>

      <div className="mt-8 bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-2">Hinweis</h2>
        <p className="text-sm text-gray-400">
          Projekt-spezifische Instruktionen k&ouml;nnen zus&auml;tzlich in den Projekt-Einstellungen hinterlegt werden.
          Wenn ein Agent <code className="text-blue-400 bg-gray-800 px-1 rounded">system_instructions_get</code> mit
          einer <code className="text-blue-400 bg-gray-800 px-1 rounded">projectId</code> aufruft,
          erh&auml;lt er sowohl die globalen als auch die projekt-spezifischen Instruktionen.
        </p>
      </div>
    </div>
  );
}
