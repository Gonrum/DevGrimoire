import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, WorkflowAgentConfig, WorkflowAgentProvider } from '../../api/client';
import Button from '../ui/Button';
import { FormInput } from '../ui/FormField';
import { SettingsActions, SettingsTabHeader } from '../ui/SettingsShell';

export default function WorkflowAgentSettings() {
  const { t } = useTranslation();

  const [waConfig, setWaConfig] = useState<WorkflowAgentConfig & { apiKeyInput?: string } | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waSaving, setWaSaving] = useState(false);
  const [waSavedMsg, setWaSavedMsg] = useState(false);
  const [waSaveError, setWaSaveError] = useState<string | null>(null);
  const [waApiKeyInput, setWaApiKeyInput] = useState('');
  const [waApiKeyClearFlag, setWaApiKeyClearFlag] = useState(false);

  const loadWorkflowAgentConfig = useCallback(async () => {
    setWaLoading(true);
    const defaults = {
      provider: 'lmstudio' as WorkflowAgentProvider,
      url: '',
      model: '',
      hasApiKey: false,
      toolsEnabled: false,
      maxToolIterations: 5,
    };
    try {
      const cfg = await api.workflowAgent.getConfig();
      setWaConfig(cfg ? { ...cfg } : defaults);
    } catch {
      // Fall back to defaults so the user can still enter a config even if the
      // load failed (e.g. transient network error). Save still hits the same endpoint.
      setWaConfig(defaults);
    }
    setWaApiKeyInput('');
    setWaApiKeyClearFlag(false);
    setWaLoading(false);
  }, []);

  useEffect(() => { loadWorkflowAgentConfig(); }, [loadWorkflowAgentConfig]);

  const saveWorkflowAgentConfig = async () => {
    if (!waConfig) return;
    setWaSaving(true);
    setWaSaveError(null);
    try {
      const payload: Parameters<typeof api.workflowAgent.updateConfig>[0] = {
        provider: waConfig.provider,
        url: waConfig.url.trim(),
        model: waConfig.model.trim(),
        toolsEnabled: waConfig.toolsEnabled,
        maxToolIterations: waConfig.maxToolIterations,
      };
      if (waApiKeyClearFlag) {
        payload.apiKey = '';
      } else if (waApiKeyInput.trim()) {
        payload.apiKey = waApiKeyInput.trim();
      }
      // else: don't include apiKey → keep stored
      const updated = await api.workflowAgent.updateConfig(payload);
      if (updated) setWaConfig({ ...updated });
      setWaApiKeyInput('');
      setWaApiKeyClearFlag(false);
      setWaSavedMsg(true);
      setTimeout(() => setWaSavedMsg(false), 2000);
    } catch (err) {
      setWaSaveError(err instanceof Error ? err.message : 'Error');
    }
    setWaSaving(false);
  };

  return (
    <>
      <SettingsTabHeader description={t('settings.workflowAgentDescription')} />

      {waLoading ? (
        <div className="text-gray-500 py-10 text-center">{t('settings.workflowAgentLoading')}</div>
      ) : waConfig === null ? (
        <div className="text-gray-500 py-4 text-center">{t('settings.workflowAgentNotConfigured')}</div>
      ) : (
        <div className="space-y-5 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('settings.workflowAgentProvider')}</label>
              <select
                value={waConfig.provider}
                onChange={(e) => setWaConfig((prev) => prev ? { ...prev, provider: e.target.value as WorkflowAgentProvider } : prev)}
                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
              >
                <option value="lmstudio">LM Studio</option>
                <option value="openai-compatible">OpenAI-Compatible</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-500 mb-1">{t('settings.workflowAgentUrl')}</label>
              <input
                type="text"
                value={waConfig.url}
                onChange={(e) => setWaConfig((prev) => prev ? { ...prev, url: e.target.value } : prev)}
                placeholder="http://localhost:1234"
                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('settings.workflowAgentModel')}</label>
              <input
                type="text"
                value={waConfig.model}
                onChange={(e) => setWaConfig((prev) => prev ? { ...prev, model: e.target.value } : prev)}
                placeholder="google/gemma-3-4b"
                className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {t('settings.workflowAgentApiKey')}
              <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded ${waConfig.hasApiKey && !waApiKeyClearFlag ? 'bg-emerald-900/50 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>
                {waConfig.hasApiKey && !waApiKeyClearFlag ? t('settings.workflowAgentApiKeySet') : t('settings.workflowAgentApiKeyNotSet')}
              </span>
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={waApiKeyInput}
                onChange={(e) => { setWaApiKeyInput(e.target.value); setWaApiKeyClearFlag(false); }}
                placeholder={t('settings.workflowAgentApiKeyPlaceholder')}
                autoComplete="off"
                className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
              {waConfig.hasApiKey && !waApiKeyClearFlag && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => { setWaApiKeyClearFlag(true); setWaApiKeyInput(''); }}
                >
                  {t('settings.workflowAgentApiKeyDelete')}
                </Button>
              )}
              {waApiKeyClearFlag && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setWaApiKeyClearFlag(false)}
                >
                  ↩
                </Button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
              <input
                type="checkbox"
                checked={waConfig.toolsEnabled}
                onChange={(e) => setWaConfig((prev) => prev ? { ...prev, toolsEnabled: e.target.checked } : prev)}
                className="w-4 h-4 accent-violet-600"
              />
              {t('settings.workflowAgentToolsEnabled')}
            </label>
            <FormInput
              fieldClassName="w-36"
              label={t('settings.workflowAgentMaxIterations')}
              type="number"
              min="1"
              max="20"
              value={waConfig.maxToolIterations}
              onChange={(e) => setWaConfig((prev) => prev ? { ...prev, maxToolIterations: parseInt(e.target.value, 10) } : prev)}
              disabled={!waConfig.toolsEnabled}
            />
          </div>

          <SettingsActions className="mt-0 border-t border-gray-800 pt-3">
            <Button variant="primary" size="lg" onClick={saveWorkflowAgentConfig} disabled={waSaving}>
              {waSaving ? t('common.saving') : t('settings.workflowAgentSave')}
            </Button>
            {waSavedMsg && <span className="text-green-400 text-sm">✓ {t('settings.workflowAgentSaved')}</span>}
            {waSaveError && <span className="text-red-400 text-sm">✗ {waSaveError}</span>}
          </SettingsActions>
        </div>
      )}
    </>
  );
}
