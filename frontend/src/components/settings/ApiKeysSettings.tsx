import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiKeyInfo } from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/narrow';
import ApiKeyToolEditor from '../ApiKeyToolEditor';
import ApiKeyScopeEditor from '../ApiKeyScopeEditor';
import Button from '../ui/Button';
import ConfirmButton from '../ui/ConfirmButton';
import { FormInput } from '../ui/FormField';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

export default function ApiKeysSettings() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const { user, authEnabled } = useAuth();
  const isAdmin = authEnabled && user?.role === 'admin';

  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyExpiry, setApiKeyExpiry] = useState('');
  const [apiKeyCreating, setApiKeyCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [editingApiKeyScopeId, setEditingApiKeyScopeId] = useState<string | null>(null);

  /*
   * `isCancelled` lässt den aufrufenden Effect ein veraltetes Ergebnis
   * verwerfen: `isAdmin` löst asynchron auf (Auth-Status, Token-Refresh), und
   * die beiden Zweige liefern *unterschiedliche* Listen. Ohne den Guard könnte
   * die langsamere Antwort die neuere überschreiben — der Nutzer sähe dann die
   * falsche Sicht (alle Keys statt nur seiner, oder umgekehrt).
   */
  const loadApiKeys = useCallback(async (isCancelled: () => boolean = () => false) => {
    setApiKeysLoading(true);
    try {
      // T-337: admins see ALL keys + owner column; non-admins keep the
      // per-user view (they only see their own).
      const keys = isAdmin ? await api.apiKeys.listAll() : await api.apiKeys.list();
      if (!isCancelled()) setApiKeys(keys);
    } catch (e) {
      if (!isCancelled()) {
        setApiKeyError(e instanceof Error ? e.message : t('common.errorLoading', { error: '' }));
      }
    } finally {
      if (!isCancelled()) setApiKeysLoading(false);
    }
  }, [t, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadApiKeys(() => cancelled);
    })();
    return () => { cancelled = true; };
  }, [loadApiKeys]);

  const saveApiKeyTools = async (id: string, tools: string[] | null) => {
    await api.apiKeys.update(id, { allowedTools: tools });
    await loadApiKeys();
  };

  const saveApiKeyScope = async (
    id: string,
    payload: {
      projectScopeMode?: 'all' | 'allowlist' | 'none';
      allowedProjectIds?: string[];
      customerScopeMode?: 'all' | 'allowlist' | 'none';
      allowedCustomerIds?: string[];
    },
  ) => {
    await api.apiKeys.update(id, payload);
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
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // `navigator.clipboard` lehnt in unsicherem Kontext (kein HTTPS) oder bei
      // verweigerter Berechtigung ab. Vorher wurde die Ablehnung verschluckt:
      // kein "Kopiert!", keine Meldung — der Nutzer hielt den Key für kopiert,
      // obwohl er nur einmal angezeigt wird. Der Fehlertext enthält den Key nicht.
      setApiKeyError(errorMessage(e, t('common.error')));
    }
  };

  return (
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
            <Button variant="primary" size="sm" onClick={() => void copyToClipboard(revealedKey)}>
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
            onClick={() => void createApiKey()}
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
                  {isAdmin && (
                    <th className="px-4 py-2 text-left font-medium text-gray-400">{t('settings.apiKeyTableOwner')}</th>
                  )}
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
                      {isAdmin && (
                        <td className="px-4 py-3 text-gray-400">{key.ownerUsername ?? '—'}</td>
                      )}
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
                          <Button
                            variant={editingApiKeyScopeId === key._id ? 'primary' : 'secondary'}
                            size="xs"
                            onClick={() =>
                              setEditingApiKeyScopeId(
                                editingApiKeyScopeId === key._id ? null : key._id,
                              )
                            }
                            title={t('settings.apiKeyScopeButtonTitle')}
                          >
                            {t('settings.apiKeyScopeButton', {
                              proj: key.projectScopeMode === 'all'
                                ? '∗'
                                : key.projectScopeMode === 'none'
                                  ? '∅'
                                  : (key.allowedProjectIds?.length ?? 0),
                              cust: key.customerScopeMode === 'all'
                                ? '∗'
                                : key.customerScopeMode === 'none'
                                  ? '∅'
                                  : (key.allowedCustomerIds?.length ?? 0),
                            })}
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

        {editingApiKeyScopeId && (() => {
          const key = apiKeys.find((k) => k._id === editingApiKeyScopeId);
          if (!key) return null;
          return (
            <div className="mt-4 rounded-lg border border-violet-700/40 bg-violet-950/20 p-1">
              <div className="px-3 pt-2 text-xs uppercase tracking-wide text-violet-300">
                {t('settings.apiKeyScopeAccessFor', { name: key.name })}
              </div>
              <ApiKeyScopeEditor
                apiKey={key}
                onSave={(payload) => saveApiKeyScope(key._id, payload)}
                onClose={() => setEditingApiKeyScopeId(null)}
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
  );
}
