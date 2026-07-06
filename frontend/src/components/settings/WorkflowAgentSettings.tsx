import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, WorkflowAgentConfig, WorkflowAgentProvider } from '../../api/client';
import Button from '../ui/Button';
import { FormInput } from '../ui/FormField';
import { SettingsActions, SettingsTabHeader } from '../ui/SettingsShell';

export default function WorkflowAgentSettings() {
  const { t } = useTranslation();

  const [waConfig, setWaConfig] = useState<WorkflowAgentConfig | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waSaving, setWaSaving] = useState(false);
  const [waSavedMsg, setWaSavedMsg] = useState(false);
  const [waSaveError, setWaSaveError] = useState<string | null>(null);

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
      // Fall back to defaults so the user can still see/save behavior options
      // even if the load failed (e.g. transient network error). Save still
      // hits the same endpoint.
      setWaConfig(defaults);
    }
    setWaLoading(false);
  }, []);

  useEffect(() => { loadWorkflowAgentConfig(); }, [loadWorkflowAgentConfig]);

  const saveWorkflowAgentConfig = async () => {
    if (!waConfig) return;
    setWaSaving(true);
    setWaSaveError(null);
    try {
      // provider/url/model are endpoint fields now managed on the central LLM
      // Endpoints page — no longer editable here. They're still required by
      // UpdateWorkflowAgentConfigDto, so pass the last-loaded values through
      // untouched. apiKey is intentionally omitted (undefined → keep stored).
      const payload: Parameters<typeof api.workflowAgent.updateConfig>[0] = {
        provider: waConfig.provider,
        url: waConfig.url,
        model: waConfig.model,
        toolsEnabled: waConfig.toolsEnabled,
        maxToolIterations: waConfig.maxToolIterations,
      };
      const updated = await api.workflowAgent.updateConfig(payload);
      if (updated) setWaConfig({ ...updated });
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
