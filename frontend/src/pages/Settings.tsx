import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiKeyInfo, ChatConfig, ChatEndpoint, ChatProvider, UserLlmConfig, LlmMode } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import UserManagement from './UserManagement';
import ReplicationSettings from '../components/ReplicationSettings';
import WebSearchSettings from '../components/WebSearchSettings';
import ApiKeyToolEditor from '../components/ApiKeyToolEditor';
import NotificationsSettings from '../components/settings/NotificationsSettings';
import BackupSettings from '../components/settings/BackupSettings';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import { FormInput, SecretInput } from '../components/ui/FormField';
import { SettingsActions, SettingsSection, SettingsShell, SettingsTabHeader } from '../components/ui/SettingsShell';

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

type SettingsTab = 'instructions' | 'apikeys' | 'notifications' | 'myllm' | 'chat' | 'websearch' | 'users' | 'replication' | 'backups';

const CHAT_PROVIDER_DEFAULT_URL: Record<ChatProvider, string> = {
  lmstudio: 'http://localhost:1234',
  'openai-compatible': 'http://localhost:1234',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

const CHAT_PROVIDER_DEFAULT_MODEL: Record<ChatProvider, string> = {
  lmstudio: 'google/gemma-3-4b',
  'openai-compatible': 'google/gemma-3-4b',
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

/** API-key expectations per provider. */
const CHAT_PROVIDER_KEY_REQUIRED: Record<ChatProvider, 'none' | 'optional' | 'required'> = {
  lmstudio: 'optional',
  'openai-compatible': 'optional',
  anthropic: 'required',
  openai: 'required',
};

/** Which providers support tool-calling today (see backend OPENAI_COMPATIBLE_PROVIDERS). */
const CHAT_PROVIDER_TOOLS_SUPPORTED: Record<ChatProvider, boolean> = {
  lmstudio: true,
  'openai-compatible': true,
  anthropic: false,
  openai: true,
};

/** Model-name patterns that imply vision support — used to preselect the Vision checkbox. */
const VISION_MODEL_PATTERNS = [
  /claude-3/i,
  /claude-4/i,
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /llava/i,
  /qwen.*-vl/i,
  /gemma-?3/i,
  /pixtral/i,
];

function modelLooksVisionCapable(model: string): boolean {
  return VISION_MODEL_PATTERNS.some((re) => re.test(model));
}

export default function Settings() {
  const { t, i18n } = useTranslation();
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
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);


  // Chat config
  const [chatConfig, setChatConfig] = useState<ChatConfig>({
    enabled: true,
    endpoints: [],
    temperature: 0.7,
    maxTokens: 2048,
    topK: 6,
    historyLimit: 10,
    toolsEnabled: false,
    toolsAllowlist: [],
    toolsMaxIterations: 5,
  });
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
  const [chatSavedMsg, setChatSavedMsg] = useState(false);
  const [chatTestResults, setChatTestResults] = useState<Record<number, { ok: boolean; error?: string; models?: string[] }>>({});

  // Per-user LLM config
  const [llmConfig, setLlmConfig] = useState<UserLlmConfig>({
    mode: 'server',
    endpoint: '',
    model: '',
    apiKey: '',
    fallbackEnabled: false,
  });
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmSavedMsg, setLlmSavedMsg] = useState(false);
  const [llmHasStoredKey, setLlmHasStoredKey] = useState(false);
  const [llmTestState, setLlmTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [llmTestMessage, setLlmTestMessage] = useState<string>('');

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

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

  useEffect(() => { load(); }, [load]);

  const loadApiKeys = useCallback(async () => {
    setApiKeysLoading(true);
    try {
      const keys = await api.apiKeys.list();
      setApiKeys(keys);
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : t('common.errorLoading', { error: '' }));
    } finally {
      setApiKeysLoading(false);
    }
  }, [t]);

  const loadChatConfig = useCallback(async () => {
    setChatLoading(true);
    try {
      const cfg = await api.chat.getConfig();
      setChatConfig(cfg);
    } catch { /* ignore */ }
    setChatLoading(false);
  }, []);

  const loadLlmConfig = useCallback(async () => {
    setLlmLoading(true);
    try {
      const profile = await api.profile.get();
      const cfg = profile.llmConfig || {};
      const storedKey = cfg.apiKey === '***';
      setLlmHasStoredKey(storedKey);
      setLlmConfig({
        mode: (cfg.mode as LlmMode) || 'server',
        endpoint: cfg.endpoint || '',
        model: cfg.model || '',
        apiKey: '',
        fallbackEnabled: !!cfg.fallbackEnabled,
      });
      setLlmTestState('idle');
      setLlmTestMessage('');
    } catch { /* ignore */ }
    setLlmLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'apikeys') loadApiKeys();
    if (tab === 'chat') loadChatConfig();
    if (tab === 'myllm') loadLlmConfig();
  }, [tab, loadApiKeys, loadChatConfig, loadLlmConfig]);

  /** Track which API-key fields are currently visible (toggle show/hide per row). */
  const [chatApiKeyVisible, setChatApiKeyVisible] = useState<Record<number, boolean>>({});

  const updateChatEndpoint = (idx: number, patch: Partial<ChatEndpoint>) => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((e, i) => {
        if (i !== idx) return e;
        const next: ChatEndpoint = { ...e, ...patch };

        // If the provider changed, auto-prefill URL + model when the user hadn't customized them
        // (i.e. the current value still matches one of the known defaults).
        if (patch.provider && patch.provider !== e.provider) {
          const wasDefaultUrl = Object.values(CHAT_PROVIDER_DEFAULT_URL).includes(e.url);
          if (!e.url || wasDefaultUrl) {
            next.url = CHAT_PROVIDER_DEFAULT_URL[patch.provider];
          }
          const wasDefaultModel = Object.values(CHAT_PROVIDER_DEFAULT_MODEL).includes(e.model);
          if (!e.model || wasDefaultModel) {
            next.model = CHAT_PROVIDER_DEFAULT_MODEL[patch.provider];
          }
          // Switching to a provider that doesn't take keys → drop any in-flight apiKey input
          if (CHAT_PROVIDER_KEY_REQUIRED[patch.provider] === 'none') {
            delete next.apiKey;
          }
          // Re-run vision heuristic on the (possibly new) model name
          if (next.visionCapable === undefined) {
            next.visionCapable = modelLooksVisionCapable(next.model);
          }
        }
        // When the user changes the model name, only auto-toggle vision if they
        // haven't explicitly set it — don't stomp on a manual choice.
        if (patch.model !== undefined && patch.model !== e.model && e.visionCapable === undefined) {
          next.visionCapable = modelLooksVisionCapable(patch.model);
        }
        return next;
      }),
    }));
    setChatSavedMsg(false);
  };

  const addChatEndpoint = () => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: [
        ...prev.endpoints,
        {
          provider: 'lmstudio',
          url: CHAT_PROVIDER_DEFAULT_URL.lmstudio,
          model: CHAT_PROVIDER_DEFAULT_MODEL.lmstudio,
        },
      ],
    }));
    setChatSavedMsg(false);
  };

  const removeChatEndpoint = (idx: number) => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.filter((_, i) => i !== idx),
    }));
    setChatTestResults((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
    setChatSavedMsg(false);
  };

  const testChatEndpoint = async (idx: number) => {
    const endpoint = chatConfig.endpoints[idx];
    if (!endpoint) return;
    try {
      const result = await api.chat.testEndpoint(endpoint);
      setChatTestResults((prev) => ({ ...prev, [idx]: result }));
    } catch (err) {
      setChatTestResults((prev) => ({ ...prev, [idx]: { ok: false, error: err instanceof Error ? err.message : 'Error' } }));
    }
  };

  const [chatSaveError, setChatSaveError] = useState<string | null>(null);

  const saveChatConfig = async () => {
    setChatSaving(true);
    setChatSaveError(null);
    try {
      // Strip `hasApiKey` (response-only metadata). `apiKey` semantics per-field:
      // undefined → keep stored, "" → delete, string → update (see ChatLlmService.setEndpoints).
      const sanitizedEndpoints = chatConfig.endpoints.map(({ hasApiKey: _omit, ...rest }) => {
        void _omit;
        return rest;
      });
      const payload = {
        enabled: chatConfig.enabled,
        endpoints: sanitizedEndpoints,
        temperature: chatConfig.temperature,
        maxTokens: chatConfig.maxTokens,
        topK: chatConfig.topK,
        historyLimit: chatConfig.historyLimit,
        toolsEnabled: chatConfig.toolsEnabled,
        toolsAllowlist: chatConfig.toolsAllowlist,
        toolsMaxIterations: chatConfig.toolsMaxIterations,
      };
      const saved = await api.chat.updateConfig(payload);
      setChatConfig(saved);
      setChatSavedMsg(true);
      setTimeout(() => setChatSavedMsg(false), 3000);
    } catch (err) {
      setChatSaveError(err instanceof Error ? err.message : 'Error');
    }
    setChatSaving(false);
  };

  const [llmSaveError, setLlmSaveError] = useState<string | null>(null);

  const saveLlmConfig = async () => {
    setLlmSaving(true);
    setLlmSaveError(null);
    try {
      const payload: UserLlmConfig = {
        mode: llmConfig.mode,
        endpoint: llmConfig.endpoint?.trim() || '',
        model: llmConfig.model?.trim() || '',
        fallbackEnabled: !!llmConfig.fallbackEnabled,
      };
      const trimmedKey = llmConfig.apiKey?.trim();
      if (trimmedKey) {
        payload.apiKey = trimmedKey;
      }
      const updated = await api.profile.update({ llmConfig: payload });
      const stored = updated.llmConfig?.apiKey === '***';
      setLlmHasStoredKey(stored);
      setLlmConfig((prev) => ({ ...prev, apiKey: '' }));
      setLlmSavedMsg(true);
      setTimeout(() => setLlmSavedMsg(false), 3000);
    } catch (err) {
      setLlmSaveError(err instanceof Error ? err.message : 'Error');
    }
    setLlmSaving(false);
  };

  const clearStoredApiKey = async () => {
    setLlmSaving(true);
    try {
      await api.profile.update({ llmConfig: { apiKey: '' } });
      setLlmHasStoredKey(false);
      setLlmConfig((prev) => ({ ...prev, apiKey: '' }));
    } catch (err) {
      setLlmSaveError(err instanceof Error ? err.message : 'Error');
    }
    setLlmSaving(false);
  };

  const testLlmEndpoint = async () => {
    const endpoint = llmConfig.endpoint?.trim();
    if (!endpoint) return;
    setLlmTestState('testing');
    setLlmTestMessage('');
    try {
      const base = endpoint.replace(/\/+$/, '');
      const url = `${base}/v1/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const trimmedKey = llmConfig.apiKey?.trim();
      if (trimmedKey) {
        headers.Authorization = `Bearer ${trimmedKey}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      setLlmTestState('ok');
      setLlmTestMessage(t('settings.myLlmTestOk', { count }));
    } catch (err) {
      setLlmTestState('fail');
      const message = err instanceof Error ? err.message : String(err);
      setLlmTestMessage(t('settings.myLlmTestFail', { error: message }));
    }
  };

  const saveApiKeyTools = async (id: string, tools: string[] | null) => {
    await api.apiKeys.update(id, { allowedTools: tools });
    await loadApiKeys();
  };

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
      setApiKeyError(e instanceof Error ? e.message : t('common.errorCreating'));
    } finally {
      setApiKeyCreating(false);
    }
  };

  const deleteApiKey = async (id: string) => {
    try {
      await api.apiKeys.delete(id);
      setApiKeys((prev) => prev.filter((k) => k._id !== id));
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : t('common.errorDeleting'));
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
      setError(e instanceof Error ? e.message : t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setInstructions(DEFAULT_INSTRUCTIONS);
    setSaved(false);
  };

  const tabs: { key: SettingsTab; label: string; group?: string; adminOnly?: boolean }[] = [
    { key: 'instructions', label: t('settings.tabInstructions'), group: t('settings.groupPersonal') },
    { key: 'notifications', label: t('settings.tabNotifications'), group: t('settings.groupPersonal') },
    { key: 'myllm', label: t('settings.tabMyLlm'), group: t('settings.groupPersonal') },
    { key: 'apikeys', label: t('settings.tabApiKeys'), group: t('settings.groupSecurity') },
    { key: 'chat', label: t('settings.tabChat'), group: t('settings.groupAdmin'), adminOnly: true },
    { key: 'websearch', label: t('settings.tabWebSearch'), group: t('settings.groupAdmin'), adminOnly: true },
    { key: 'backups', label: t('settings.tabBackups'), group: t('settings.groupAdmin'), adminOnly: true },
    { key: 'users', label: t('settings.tabUsers'), group: t('settings.groupAdmin'), adminOnly: true },
    { key: 'replication', label: t('settings.tabReplication'), group: t('settings.groupAdmin'), adminOnly: true },
  ];

  const visibleTabs = tabs.filter((tb) => !tb.adminOnly || isAdmin);

  return (
    <SettingsShell title={t('settings.title')} tabs={visibleTabs} activeTab={tab} onTabChange={setTab}>

      {tab === 'instructions' && (
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
                <Button variant="primary" size="lg" onClick={save} disabled={saving || saved}>
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
      )}

      {tab === 'apikeys' && (
        <>
          <SettingsTabHeader description={t('settings.apiKeysDescription')} />

          {apiKeyError && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded mb-4">
              {apiKeyError}
            </div>
          )}

          {revealedKey && (
            <div className="mb-6 rounded-lg border-2 border-amber-700 bg-amber-950/30 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-300">
                <span>⚠</span>
                <span>{t('settings.apiKeyCreated')}</span>
              </div>
              <p className="mb-3 text-xs text-amber-200/90">
                {t('settings.apiKeyRevealedWarning')}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-gray-950 px-3 py-2 font-mono text-sm text-green-400">
                  {revealedKey}
                </code>
                <Button variant="primary" size="sm" onClick={() => copyToClipboard(revealedKey)}>
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
              <div className="mt-3 flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setRevealedKey(null)}>
                  {t('settings.apiKeyRevealedAck')}
                </Button>
              </div>
            </div>
          )}

          <SettingsSection title={t('settings.createApiKey')} className="mb-6">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <FormInput
                fieldClassName="flex-1 min-w-0"
                label={t('settings.apiKeyName')}
                type="text"
                value={apiKeyName}
                onChange={(e) => setApiKeyName(e.target.value)}
                placeholder={t('settings.apiKeyNamePlaceholder')}
              />
              <FormInput
                fieldClassName="w-full sm:w-auto"
                label={t('settings.apiKeyExpiry')}
                type="date"
                value={apiKeyExpiry}
                onChange={(e) => setApiKeyExpiry(e.target.value)}
              />
              <Button
                variant="primary"
                onClick={createApiKey}
                disabled={apiKeyCreating || !apiKeyName.trim()}
              >
                {apiKeyCreating ? t('common.creating') : t('common.create')}
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection
            title={t('settings.apiKeyActiveTitle')}
            description={t('settings.apiKeyActiveDescription')}
            meta={apiKeys.length > 0 ? `${apiKeys.length}` : undefined}
            className="mb-6"
          >
            {apiKeysLoading ? (
              <div className="py-8 text-center text-sm text-gray-500">{t('common.loading')}</div>
            ) : apiKeys.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-500">{t('settings.noApiKeys')}</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-800">
                <table className="w-full min-w-[600px] text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 bg-gray-800/50">
                      <th className="px-4 py-2 text-left font-medium text-gray-400">{t('settings.apiKeyTableName')}</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-400">Key</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-400">{t('settings.apiKeyTableCreated')}</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-400">{t('settings.apiKeyTableLastUsed')}</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-400">{t('settings.apiKeyTableExpiry')}</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((key) => {
                      const isAllTools = !Array.isArray(key.allowedTools);
                      const isExpired = key.expiresAt && new Date(key.expiresAt) < new Date();
                      const isSelected = editingApiKeyId === key._id;
                      return (
                        <tr
                          key={key._id}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`border-b border-gray-800 last:border-0 ${isSelected ? 'bg-violet-900/20' : ''}`}
                        >
                          <td className="px-4 py-3 text-gray-200">
                            <div className="flex items-center gap-2">
                              {isAllTools && (
                                <span title={t('settings.apiKeyRiskAllTools')} className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                              )}
                              {key.name}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <code className="font-mono text-xs text-gray-400">{key.prefix}...</code>
                          </td>
                          <td className="px-4 py-3 text-gray-400">
                            {new Date(key.createdAt).toLocaleDateString(dateLocale)}
                          </td>
                          <td className="px-4 py-3 text-gray-400">
                            {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString(dateLocale) : t('common.neverUsed')}
                          </td>
                          <td className={`px-4 py-3 ${isExpired ? 'text-red-400' : 'text-gray-400'}`}>
                            {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString(dateLocale) : t('common.noExpiry')}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant={isSelected ? 'primary' : 'secondary'}
                                size="xs"
                                onClick={() => setEditingApiKeyId(isSelected ? null : key._id)}
                              >
                                {Array.isArray(key.allowedTools)
                                  ? t('settings.apiKeyToolsScoped', { count: key.allowedTools.length })
                                  : t('settings.apiKeyToolsAll')}
                              </Button>
                              <ConfirmButton
                                onConfirm={() => deleteApiKey(key._id)}
                                label={t('common.delete')}
                                confirmLabel={t('common.confirmDelete')}
                                variant="danger"
                                size="xs"
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {editingApiKeyId && (() => {
              const key = apiKeys.find((k) => k._id === editingApiKeyId);
              if (!key) return null;
              return (
                <div className="mt-4 rounded-lg border border-violet-700/40 bg-violet-950/20 p-1">
                  <div className="px-3 pt-2 text-xs uppercase tracking-wide text-violet-300">
                    {t('settings.apiKeyToolAccessFor', { name: key.name })}
                  </div>
                  <ApiKeyToolEditor
                    apiKey={key}
                    onSave={(tools) => saveApiKeyTools(key._id, tools)}
                    onClose={() => setEditingApiKeyId(null)}
                  />
                </div>
              );
            })()}
          </SettingsSection>

          <SettingsSection title={t('settings.apiKeyUsageTitle')} description={t('settings.apiKeyUsageText')}>
            <div className="space-y-2 rounded bg-gray-950/60 p-3 font-mono text-xs text-gray-400">
              <div><span className="text-gray-500"># Header</span></div>
              <div>Authorization: Bearer cv_...</div>
              <div className="mt-2"><span className="text-gray-500"># Query Parameter</span></div>
              <div>?apiKey=cv_...</div>
            </div>
          </SettingsSection>
        </>
      )}

      {tab === 'notifications' && <NotificationsSettings />}




      {tab === 'chat' && isAdmin && (
        <>
          <SettingsTabHeader description={t('settings.chatDescription')} />

          {chatLoading ? (
            <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>
          ) : (
            <div className="space-y-6">
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chatConfig.enabled !== false}
                    onChange={(e) => {
                      setChatConfig((prev) => ({ ...prev, enabled: e.target.checked }));
                      setChatSavedMsg(false);
                    }}
                    className="mt-1 w-4 h-4 accent-violet-600"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-200">{t('settings.chatFeatureEnabled')}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{t('settings.chatFeatureEnabledHint')}</div>
                  </div>
                </label>
              </div>

              <SettingsSection
                title={t('settings.chatEndpoints')}
                description={t('settings.chatEndpointsDescription')}
                meta={chatConfig.endpoints.length > 0 ? `${chatConfig.endpoints.length}` : undefined}
              >
                <div className="mb-3 flex justify-end">
                  <Button size="sm" onClick={addChatEndpoint}>{t('settings.chatAddEndpoint')}</Button>
                </div>

                {chatConfig.endpoints.length === 0 ? (
                  <div className="text-gray-500 text-sm py-4 text-center">{t('settings.chatNoEndpoints')}</div>
                ) : (
                  <div className="space-y-3">
                    {chatConfig.endpoints.map((endpoint, idx) => {
                      const result = chatTestResults[idx];
                      const keyReq = CHAT_PROVIDER_KEY_REQUIRED[endpoint.provider];
                      const keySupported = keyReq !== 'none';
                      const keyRequired = keyReq === 'required';
                      const isLocal = keyReq === 'none' || keyReq === 'optional';
                      const hasStoredKey = !!endpoint.hasApiKey;
                      const keyVisible = !!chatApiKeyVisible[idx];
                      const toolsSupported = CHAT_PROVIDER_TOOLS_SUPPORTED[endpoint.provider];
                      return (
                        <div key={idx} className="bg-gray-800 border border-gray-700 rounded p-3">
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-2">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">{t('settings.chatProvider')}</label>
                              <select
                                value={endpoint.provider}
                                onChange={(e) => updateChatEndpoint(idx, { provider: e.target.value as ChatProvider })}
                                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                              >
                                <option value="lmstudio">{t('settings.chatProviderLmStudio')}</option>
                                <option value="openai-compatible">{t('settings.chatProviderOpenAiCompatible')}</option>
                                <option value="anthropic">{t('settings.chatProviderAnthropic')}</option>
                                <option value="openai">{t('settings.chatProviderOpenAi')}</option>
                              </select>
                              <div className="mt-1 text-[11px]">
                                {isLocal ? (
                                  <span className="text-emerald-400">● {t('settings.chatProviderHintLocal')}</span>
                                ) : (
                                  <span className="text-amber-400">● {t('settings.chatProviderHintCloud')}</span>
                                )}
                              </div>
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-xs text-gray-500 mb-1">{t('settings.chatUrl')}</label>
                              <input
                                type="text"
                                value={endpoint.url}
                                onChange={(e) => updateChatEndpoint(idx, { url: e.target.value })}
                                placeholder={CHAT_PROVIDER_DEFAULT_URL[endpoint.provider]}
                                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">{t('settings.chatModel')}</label>
                              <input
                                type="text"
                                value={endpoint.model}
                                onChange={(e) => updateChatEndpoint(idx, { model: e.target.value })}
                                placeholder={CHAT_PROVIDER_DEFAULT_MODEL[endpoint.provider]}
                                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                              />
                            </div>
                          </div>

                          {keySupported && (
                            <div className="mb-2">
                              <label className="block text-xs text-gray-500 mb-1">
                                {t('settings.chatApiKey')}
                                {keyRequired && <span className="text-red-400 ml-1">*</span>}
                              </label>
                              <div className="flex gap-2">
                                <input
                                  type={keyVisible ? 'text' : 'password'}
                                  value={endpoint.apiKey ?? ''}
                                  onChange={(e) => updateChatEndpoint(idx, { apiKey: e.target.value })}
                                  placeholder={
                                    hasStoredKey && endpoint.apiKey === undefined
                                      ? t('settings.chatApiKeyPlaceholderStored')
                                      : endpoint.provider === 'anthropic'
                                        ? 'sk-ant-...'
                                        : 'sk-...'
                                  }
                                  autoComplete="off"
                                  className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
                                />
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setChatApiKeyVisible((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                                >
                                  {keyVisible ? t('settings.chatApiKeyHide') : t('settings.chatApiKeyShow')}
                                </Button>
                                {hasStoredKey && (
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    onClick={() => updateChatEndpoint(idx, { apiKey: '' })}
                                  >
                                    {t('settings.chatApiKeyClear')}
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="mb-2 flex items-center gap-2">
                            <label className="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={!!endpoint.visionCapable}
                                onChange={(e) => updateChatEndpoint(idx, { visionCapable: e.target.checked })}
                                className="w-3.5 h-3.5 accent-violet-600"
                              />
                              {t('settings.chatVisionCapable')}
                            </label>
                            <span className="text-[11px] text-gray-500">{t('settings.chatVisionCapableHint')}</span>
                          </div>

                          {chatConfig.toolsEnabled && !toolsSupported && (
                            <div className="mb-2 text-[11px] text-amber-300/80 bg-amber-900/10 border border-amber-800/30 rounded px-2 py-1">
                              ⓘ {t('settings.chatToolsSkippedForProvider')}
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs flex-1">
                              {result?.ok && (
                                <span className="text-green-400">
                                  ✓ {t('settings.chatTestOk')}
                                  {result.models && result.models.length > 0 && (
                                    <span className="text-gray-500"> · {result.models.length} Modelle</span>
                                  )}
                                </span>
                              )}
                              {result && !result.ok && (
                                <span className="text-red-400">{t('settings.chatTestFail', { error: result.error })}</span>
                              )}
                            </div>
                            <Button size="sm" onClick={() => testChatEndpoint(idx)}>{t('settings.chatTestEndpoint')}</Button>
                            <Button variant="danger" size="sm" onClick={() => removeChatEndpoint(idx)}>{t('settings.chatRemoveEndpoint')}</Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsSection>

              <SettingsSection title={t('settings.chatAdvancedTitle')} description={t('settings.chatAdvancedDescription')}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <FormInput
                    label={t('settings.chatTemperature')}
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={chatConfig.temperature ?? 0.7}
                    onChange={(e) => { setChatConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) })); setChatSavedMsg(false); }}
                  />
                  <FormInput
                    label={t('settings.chatMaxTokens')}
                    type="number"
                    min="1"
                    value={chatConfig.maxTokens ?? 2048}
                    onChange={(e) => { setChatConfig((prev) => ({ ...prev, maxTokens: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
                  />
                  <FormInput
                    label={t('settings.chatTopK')}
                    type="number"
                    min="1"
                    max="20"
                    value={chatConfig.topK ?? 6}
                    onChange={(e) => { setChatConfig((prev) => ({ ...prev, topK: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
                  />
                  <FormInput
                    label={t('settings.chatHistoryLimit')}
                    type="number"
                    min="1"
                    max="50"
                    value={chatConfig.historyLimit ?? 10}
                    onChange={(e) => { setChatConfig((prev) => ({ ...prev, historyLimit: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
                  />
                </div>
              </SettingsSection>

              <SettingsSection title={t('settings.chatToolsTitle')} description={t('settings.chatToolsDescription')}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={chatConfig.toolsEnabled ?? false}
                      onChange={(e) => { setChatConfig((prev) => ({ ...prev, toolsEnabled: e.target.checked })); setChatSavedMsg(false); }}
                      className="w-4 h-4 accent-violet-600"
                    />
                    <span className="text-sm font-medium text-gray-200">{t('settings.chatToolsEnable')}</span>
                  </label>
                  <FormInput
                    fieldClassName="w-32"
                    label={t('settings.chatToolsMaxIterations')}
                    type="number"
                    min="1"
                    max="10"
                    value={chatConfig.toolsMaxIterations ?? 5}
                    onChange={(e) => { setChatConfig((prev) => ({ ...prev, toolsMaxIterations: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
                    disabled={!chatConfig.toolsEnabled}
                  />
                </div>

                <div className="mt-3 bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2 text-xs text-amber-200">
                  ⚠ {t('settings.chatToolsHint')}
                </div>

                {chatConfig.toolsEnabled && chatConfig.toolGroups && (() => {
                  const allowlist = chatConfig.toolsAllowlist ?? [];
                  const writeTools = new Set(chatConfig.writeTools ?? []);
                  const activeWriteCount = allowlist.filter((tool) => writeTools.has(tool)).length;
                  return (
                    <div className="space-y-3 pt-1">
                      <div className="text-xs text-gray-400 font-medium">{t('settings.chatToolsAllowlist')}</div>

                      {activeWriteCount > 0 && (
                        <div className="bg-red-900/20 border border-red-800/50 rounded px-3 py-2 text-xs text-red-200">
                          ⚠ {t('settings.chatToolsWriteBanner', { count: activeWriteCount })}
                        </div>
                      )}

                      {Object.entries(chatConfig.toolGroups).map(([groupKey, tools]) => {
                        const isWriteGroup = groupKey.endsWith('_write');
                        const allOn = tools.every((tool) => allowlist.includes(tool));
                        const someOn = tools.some((tool) => allowlist.includes(tool));
                        const toggleGroup = () => {
                          if (!allOn && isWriteGroup) {
                            const msg = t('settings.chatToolsSelectAllWriteConfirm', { count: tools.length });
                            if (!window.confirm(msg)) return;
                          }
                          const next = allOn
                            ? allowlist.filter((a) => !tools.includes(a))
                            : Array.from(new Set([...allowlist, ...tools]));
                          setChatConfig((prev) => ({ ...prev, toolsAllowlist: next }));
                          setChatSavedMsg(false);
                        };
                        const toggleTool = (tool: string) => {
                          const next = allowlist.includes(tool)
                            ? allowlist.filter((a) => a !== tool)
                            : [...allowlist, tool];
                          setChatConfig((prev) => ({ ...prev, toolsAllowlist: next }));
                          setChatSavedMsg(false);
                        };
                        const boxCls = isWriteGroup
                          ? 'bg-red-950/20 border-red-900/50'
                          : 'bg-gray-800 border-gray-700';
                        return (
                          <div key={groupKey} className={`border rounded p-2.5 ${boxCls}`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-xs font-medium text-gray-300 flex items-center gap-2">
                                {t(`settings.chatToolsGroup_${groupKey}`)}
                                {isWriteGroup && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-900/60 text-red-200 border border-red-800 uppercase tracking-wide">
                                    {t('settings.chatToolsWriteBadge')}
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={toggleGroup}
                                className={`text-xs ${isWriteGroup ? 'text-red-300 hover:text-red-200' : 'text-cyan-400 hover:text-cyan-300'}`}
                              >
                                {allOn ? t('settings.chatToolsSelectNone') : t('settings.chatToolsSelectAll')}
                                <span className="text-gray-500 ml-1">({tools.filter((tool) => allowlist.includes(tool)).length}/{tools.length})</span>
                              </button>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                              {tools.map((tool) => (
                                <label
                                  key={tool}
                                  className={`flex items-center gap-1.5 cursor-pointer text-xs hover:text-gray-200 ${
                                    isWriteGroup ? 'text-red-200/80' : 'text-gray-400'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={allowlist.includes(tool)}
                                    onChange={() => toggleTool(tool)}
                                    className={`w-3.5 h-3.5 ${isWriteGroup ? 'accent-red-600' : 'accent-violet-600'}`}
                                  />
                                  <span className="font-mono">{tool}</span>
                                </label>
                              ))}
                            </div>
                            {!allOn && someOn && (
                              <div className="text-xs text-gray-600 mt-1.5">
                                {tools.filter((tool) => allowlist.includes(tool)).length} / {tools.length}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </SettingsSection>

              <SettingsActions className="mt-0">
                <Button variant="primary" size="lg" onClick={saveChatConfig} disabled={chatSaving}>
                  {chatSaving ? t('common.saving') : t('common.save')}
                </Button>
                {chatSavedMsg && <span className="text-green-400 text-sm">✓ {t('settings.chatSaved')}</span>}
                {chatSaveError && <span className="text-red-400 text-sm">✗ {chatSaveError}</span>}
              </SettingsActions>
            </div>
          )}
        </>
      )}

      {tab === 'myllm' && (
        <div className="space-y-4">
          <SettingsTabHeader description={t('settings.myLlmDescription')} className="mb-0" />

          {typeof window !== 'undefined' && window.location.protocol === 'https:' && (
            <div className="bg-amber-900/30 border border-amber-700/60 text-amber-200 text-sm px-3 py-2 rounded">
              {t('settings.myLlmMixedContentWarning')}
            </div>
          )}

          {llmLoading ? (
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : (
            <div className="space-y-4 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  {t('settings.myLlmMode')}
                </label>
                <div className="space-y-1.5">
                  <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                    <input
                      type="radio"
                      name="llm-mode"
                      checked={llmConfig.mode === 'server'}
                      onChange={() => {
                        setLlmConfig((prev) => ({ ...prev, mode: 'server' }));
                        setLlmSavedMsg(false);
                      }}
                      className="mt-0.5 accent-cyan-500"
                    />
                    <span>{t('settings.myLlmModeServer')}</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                    <input
                      type="radio"
                      name="llm-mode"
                      checked={llmConfig.mode === 'browser'}
                      onChange={() => {
                        setLlmConfig((prev) => ({ ...prev, mode: 'browser' }));
                        setLlmSavedMsg(false);
                      }}
                      className="mt-0.5 accent-cyan-500"
                    />
                    <span>{t('settings.myLlmModeBrowser')}</span>
                  </label>
                </div>
              </div>

              {llmConfig.mode === 'browser' && (
                <>
                  <FormInput
                    label={t('settings.myLlmEndpoint')}
                    type="url"
                    value={llmConfig.endpoint || ''}
                    onChange={(e) => {
                      setLlmConfig((prev) => ({ ...prev, endpoint: e.target.value }));
                      setLlmSavedMsg(false);
                      setLlmTestState('idle');
                    }}
                    placeholder="http://localhost:1234"
                    className="font-mono"
                    helpText={t('settings.myLlmEndpointHint')}
                  />

                  <FormInput
                    label={t('settings.myLlmModel')}
                    type="text"
                    value={llmConfig.model || ''}
                    onChange={(e) => {
                      setLlmConfig((prev) => ({ ...prev, model: e.target.value }));
                      setLlmSavedMsg(false);
                    }}
                    placeholder="google/gemma-3-4b"
                    className="font-mono"
                    helpText={t('settings.myLlmModelHint')}
                  />

                  <div className="flex items-end gap-2">
                    <SecretInput
                      fieldClassName="flex-1 min-w-0"
                      label={t('settings.myLlmApiKey')}
                      value={llmConfig.apiKey || ''}
                      onChange={(e) => {
                        setLlmConfig((prev) => ({ ...prev, apiKey: e.target.value }));
                        setLlmSavedMsg(false);
                      }}
                      placeholder={llmHasStoredKey ? t('settings.myLlmApiKeyStored') : ''}
                      className="font-mono"
                      helpText={t('settings.myLlmApiKeyHint')}
                    />
                    {llmHasStoredKey && (
                      <ConfirmButton
                        variant="secondary"
                        size="sm"
                        label={t('settings.myLlmApiKeyClear')}
                        onConfirm={clearStoredApiKey}
                        disabled={llmSaving}
                      />
                    )}
                  </div>

                  <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={!!llmConfig.fallbackEnabled}
                      onChange={(e) => {
                        setLlmConfig((prev) => ({ ...prev, fallbackEnabled: e.target.checked }));
                        setLlmSavedMsg(false);
                      }}
                      className="mt-0.5 w-4 h-4 accent-cyan-500"
                    />
                    <span>
                      <div>{t('settings.myLlmFallback')}</div>
                      <div className="text-xs text-gray-500">{t('settings.myLlmFallbackHint')}</div>
                    </span>
                  </label>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={testLlmEndpoint}
                      disabled={!llmConfig.endpoint?.trim() || llmTestState === 'testing'}
                    >
                      {llmTestState === 'testing' ? '...' : t('settings.myLlmTest')}
                    </Button>
                    {llmTestState === 'ok' && <span className="text-green-400 text-sm">✓ {llmTestMessage}</span>}
                    {llmTestState === 'fail' && <span className="text-red-400 text-sm">✗ {llmTestMessage}</span>}
                  </div>
                </>
              )}

              <SettingsActions className="mt-0 border-t border-gray-800 pt-3">
                <Button variant="primary" size="lg" onClick={saveLlmConfig} disabled={llmSaving}>
                  {llmSaving ? t('common.saving') : t('common.save')}
                </Button>
                {llmSavedMsg && <span className="text-green-400 text-sm">✓ {t('settings.myLlmSaved')}</span>}
                {llmSaveError && <span className="text-red-400 text-sm">✗ {llmSaveError}</span>}
              </SettingsActions>
            </div>
          )}
        </div>
      )}

      {tab === 'users' && isAdmin && <UserManagement />}
      {tab === 'websearch' && isAdmin && <WebSearchSettings />}
      {tab === 'backups' && isAdmin && <BackupSettings />}

      {tab === 'replication' && isAdmin && <ReplicationSettings />}
    </SettingsShell>
  );
}
