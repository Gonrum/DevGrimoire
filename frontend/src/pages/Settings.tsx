import { useState, useEffect, useCallback } from 'react';
import { api, ApiKeyInfo } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import UserManagement from './UserManagement';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';

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

type SettingsTab = 'instructions' | 'apikeys' | 'users';

export default function Settings() {
  const { user, authEnabled } = useAuth();
  const isAdmin = authEnabled && user?.role === 'admin';
  const [tab, setTab] = useState<SettingsTab>('instructions');

  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyExpiry, setApiKeyExpiry] = useState('');
  const [apiKeyCreating, setApiKeyCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const loadApiKeys = useCallback(async () => {
    setApiKeysLoading(true);
    try {
      const keys = await api.apiKeys.list();
      setApiKeys(keys);
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : 'Fehler beim Laden');
    } finally {
      setApiKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'apikeys') loadApiKeys();
  }, [tab, loadApiKeys]);

  const createApiKey = async () => {
    if (!apiKeyName.trim()) return;
    setApiKeyCreating(true);
    setApiKeyError(null);
    try {
      const result = await api.apiKeys.create({
        name: apiKeyName.trim(),
        expiresAt: apiKeyExpiry || undefined,
      });
      setRevealedKey(result.key);
      setApiKeyName('');
      setApiKeyExpiry('');
      await loadApiKeys();
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : 'Fehler beim Erstellen');
    } finally {
      setApiKeyCreating(false);
    }
  };

  const deleteApiKey = async (id: string) => {
    try {
      await api.apiKeys.delete(id);
      setApiKeys((prev) => prev.filter((k) => k._id !== id));
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : 'Fehler beim Löschen');
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

  const tabs: { key: SettingsTab; label: string; adminOnly?: boolean }[] = [
    { key: 'instructions', label: 'Agent-Instruktionen' },
    { key: 'apikeys', label: 'API Keys' },
    { key: 'users', label: 'Benutzerverwaltung', adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-4">Einstellungen</h1>

      {visibleTabs.length > 1 && (
        <div className="flex gap-1 mb-6 border-b border-gray-800">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t.key
                  ? 'text-blue-400 border-blue-400'
                  : 'text-gray-400 border-transparent hover:text-gray-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'instructions' && (
        <>
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

          {loading ? (
            <div className="text-gray-500 py-10 text-center">Laden...</div>
          ) : (
            <>
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
                <Button variant="primary" size="lg" onClick={save} disabled={saving || saved}>
                  {saving ? 'Speichern...' : 'Speichern'}
                </Button>
                <Button size="lg" onClick={reset}>
                  Auf Standard zur&uuml;cksetzen
                </Button>
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
            </>
          )}
        </>
      )}

      {tab === 'apikeys' && (
        <>
          <p className="text-gray-400 mb-6">
            API Keys f&uuml;r MCP-Zugriff und REST API Authentifizierung.
            Keys werden nur einmalig bei der Erstellung angezeigt.
          </p>

          {apiKeyError && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded mb-4">
              {apiKeyError}
            </div>
          )}

          {revealedKey && (
            <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 mb-6">
              <p className="text-green-300 text-sm font-medium mb-2">
                API Key erstellt — jetzt kopieren, er wird nicht mehr angezeigt!
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-gray-900 text-green-400 px-3 py-2 rounded font-mono text-sm break-all">
                  {revealedKey}
                </code>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => copyToClipboard(revealedKey)}
                >
                  {copied ? 'Kopiert!' : 'Kopieren'}
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setRevealedKey(null)}
                className="text-xs text-gray-500 hover:text-gray-300 mt-2"
              >
                Schlie&szlig;en
              </button>
            </div>
          )}

          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-6">
            <h2 className="text-sm font-medium text-gray-300 mb-3">Neuen API Key erstellen</h2>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  value={apiKeyName}
                  onChange={(e) => setApiKeyName(e.target.value)}
                  placeholder="z.B. MCP Server, CI/CD..."
                  className="w-full bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ablaufdatum (optional)</label>
                <input
                  type="date"
                  value={apiKeyExpiry}
                  onChange={(e) => setApiKeyExpiry(e.target.value)}
                  className="bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <Button
                variant="primary"
                onClick={createApiKey}
                disabled={apiKeyCreating || !apiKeyName.trim()}
              >
                {apiKeyCreating ? 'Erstellen...' : 'Erstellen'}
              </Button>
            </div>
          </div>

          {apiKeysLoading ? (
            <div className="text-gray-500 py-10 text-center">Laden...</div>
          ) : apiKeys.length === 0 ? (
            <div className="text-gray-500 py-10 text-center">Keine API Keys vorhanden.</div>
          ) : (
            <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 bg-gray-800/50">
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Name</th>
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Key</th>
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Erstellt</th>
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Zuletzt genutzt</th>
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Ablauf</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((key) => (
                    <tr key={key._id} className="border-b border-gray-800 last:border-0">
                      <td className="px-4 py-3 text-gray-200">{key.name}</td>
                      <td className="px-4 py-3">
                        <code className="text-gray-400 font-mono text-xs">{key.prefix}...</code>
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {new Date(key.createdAt).toLocaleDateString('de-DE')}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleDateString('de-DE')
                          : 'Nie'}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {key.expiresAt
                          ? new Date(key.expiresAt).toLocaleDateString('de-DE')
                          : 'Kein Ablauf'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ConfirmButton
                          onConfirm={() => deleteApiKey(key._id)}
                          label="Löschen"
                          confirmLabel="Sicher?"
                          variant="danger"
                          size="xs"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-8 bg-gray-800/50 border border-gray-700 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-300 mb-2">Verwendung</h2>
            <p className="text-sm text-gray-400 mb-2">
              API Keys k&ouml;nnen f&uuml;r MCP-Server und REST API Zugriff verwendet werden:
            </p>
            <div className="space-y-2 text-xs font-mono text-gray-400 bg-gray-900 rounded p-3">
              <div><span className="text-gray-500"># Header</span></div>
              <div>Authorization: Bearer cv_...</div>
              <div className="mt-2"><span className="text-gray-500"># Query Parameter</span></div>
              <div>?apiKey=cv_...</div>
            </div>
          </div>
        </>
      )}

      {tab === 'users' && isAdmin && <UserManagement />}
    </div>
  );
}
