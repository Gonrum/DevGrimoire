import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import Button from '../ui/Button';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

const DEFAULT_INSTRUCTIONS = `# DevGrimoire Agent-Instruktionen

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

export default function InstructionsSettings() {
  const { t } = useTranslation();
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
      setError(e instanceof Error ? e.message : t('common.errorLoading', { error: '' }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const save = async () => {

    setSaving(true);
    setError(null);
    try {
      await api.settings.set('agent_instructions', instructions);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setInstructions(DEFAULT_INSTRUCTIONS);
    setSaved(false);
  };

  return (
    <>
      <SettingsTabHeader description={t('settings.instructionsDescription', { tool: 'system_instructions_get' })} />

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>
      ) : (
        <>
          <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800/50">
              <span className="text-sm text-gray-400 font-medium">{t('settings.instructionsLabel')}</span>
              <div className="flex items-center gap-2">
                {!saved && (
                  <span className="text-xs text-yellow-500">{t('settings.unsavedChanges')}</span>
                )}
              </div>
            </div>
            <textarea
              value={instructions}
              onChange={(e) => { setInstructions(e.target.value); setSaved(false); }}
              className="w-full h-[300px] sm:h-[500px] bg-gray-900 text-gray-200 px-4 py-3 font-mono text-sm resize-y focus:outline-none focus:ring-1 focus:ring-violet-500"
              spellCheck={false}
            />
          </div>

          <SettingsActions>
            <Button variant="primary" size="lg" onClick={() => void save()} disabled={saving || saved}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button size="lg" onClick={reset}>
              {t('settings.resetDefault')}
            </Button>
          </SettingsActions>

          <SettingsSection title={t('settings.instructionsNote')} className="mt-8">
            <p className="text-sm text-gray-400">
              {t('settings.instructionsNoteText', { tool: 'system_instructions_get', param: 'projectId' })}
            </p>
          </SettingsSection>
        </>
      )}
    </>
  );
}
