import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, RagConfig, RagEndpoint, RagEndpointTestResult, RagProvider } from '../../api/client';
import Button from '../ui/Button';
import { FormInput, FormSelect, SecretInput } from '../ui/FormField';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

const PROVIDERS: RagProvider[] = ['ollama', 'openai-compatible'];

const DEFAULT_BY_PROVIDER: Record<RagProvider, Pick<RagEndpoint, 'url' | 'model'>> = {
  ollama: { url: 'http://localhost:11434', model: 'nomic-embed-text' },
  'openai-compatible': { url: 'http://localhost:1234', model: 'text-embedding-nomic-embed-text-v1.5' },
};

function blankEndpoint(provider: RagProvider = 'ollama'): RagEndpoint {
  return { provider, ...DEFAULT_BY_PROVIDER[provider], apiKey: '' };
}

function normalizeForSave(endpoint: RagEndpoint): RagEndpoint {
  const out: RagEndpoint = {
    provider: endpoint.provider,
    url: endpoint.url.trim(),
    model: endpoint.model.trim(),
  };
  // undefined keeps an existing stored key; an explicit empty string deletes it.
  if (endpoint.apiKey !== undefined) out.apiKey = endpoint.apiKey;
  return out;
}

export default function RagSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<RagConfig>({ endpoints: [], managedViaSettings: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<number, RagEndpointTestResult & { testing?: boolean }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.rag.getConfig();
      setConfig({
        ...next,
        endpoints: next.endpoints.length > 0
          ? next.endpoints.map((endpoint) => ({ ...endpoint, apiKey: undefined }))
          : [blankEndpoint()],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorLoading', { error: '' }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const updateEndpoint = (idx: number, patch: Partial<RagEndpoint>) => {
    setConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((endpoint, i) => {
        if (i !== idx) return endpoint;
        const provider = patch.provider ?? endpoint.provider;
        const defaults = provider !== endpoint.provider ? DEFAULT_BY_PROVIDER[provider] : {};
        return { ...endpoint, ...defaults, ...patch };
      }),
    }));
    setSuccess(null);
  };

  const addEndpoint = () => {
    setConfig((prev) => ({ ...prev, endpoints: [...prev.endpoints, blankEndpoint()] }));
    setSuccess(null);
  };

  const removeEndpoint = (idx: number) => {
    setConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.filter((_, i) => i !== idx),
    }));
    setSuccess(null);
  };

  const moveEndpoint = (idx: number, dir: -1 | 1) => {
    setConfig((prev) => {
      const endpoints = [...prev.endpoints];
      const target = idx + dir;
      if (target < 0 || target >= endpoints.length) return prev;
      [endpoints[idx], endpoints[target]] = [endpoints[target], endpoints[idx]];
      return { ...prev, endpoints };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const endpoints = config.endpoints.map(normalizeForSave);
      const next = await api.rag.updateConfig({ endpoints });
      setConfig({ ...next, endpoints: next.endpoints.map((endpoint) => ({ ...endpoint, apiKey: undefined })) });
      setSuccess(t('settings.ragSaved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const testEndpoint = async (idx: number) => {
    setTestResults((prev) => ({ ...prev, [idx]: { ok: false, testing: true } }));
    try {
      const result = await api.rag.testEndpoint(config.endpoints[idx]);
      setTestResults((prev) => ({ ...prev, [idx]: result }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [idx]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.rag.reindex();
      setSuccess(t('settings.ragReindexStarted', { count: result.indexed ?? 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.ragReindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  if (loading) {
    return <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsTabHeader description={t('settings.ragDescription')} />

      {error && <div className="mb-4 rounded border border-red-700 bg-red-900/50 px-4 py-2 text-red-300">{error}</div>}
      {success && <div className="mb-4 rounded border border-green-700 bg-green-900/40 px-4 py-2 text-green-300">{success}</div>}

      <SettingsSection
        title={t('settings.ragEndpoints')}
        description={t('settings.ragEndpointsDescription')}
        meta={config.managedViaSettings ? t('settings.ragManagedDb') : t('settings.ragManagedEnv')}
      >
        <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {t('settings.ragReindexWarning')}
        </div>

        <div className="space-y-4">
          {config.endpoints.map((endpoint, idx) => {
            const test = testResults[idx];
            return (
              <div key={idx} className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-gray-200">{idx === 0 ? t('settings.ragPrimaryEndpoint') : t('settings.ragFallbackEndpoint', { number: idx })}</div>
                    <div className="text-xs text-gray-500">{t('settings.ragEndpointOrderHint')}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="xs" onClick={() => moveEndpoint(idx, -1)} disabled={idx === 0}>↑</Button>
                    <Button size="xs" onClick={() => moveEndpoint(idx, 1)} disabled={idx === config.endpoints.length - 1}>↓</Button>
                    <Button size="xs" variant="danger" onClick={() => removeEndpoint(idx)} disabled={config.endpoints.length <= 1}>{t('common.remove')}</Button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <FormSelect
                    label={t('settings.ragProvider')}
                    value={endpoint.provider}
                    onChange={(e) => updateEndpoint(idx, { provider: e.target.value as RagProvider })}
                  >
                    {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                  </FormSelect>
                  <FormInput
                    label={t('settings.ragUrl')}
                    value={endpoint.url}
                    onChange={(e) => updateEndpoint(idx, { url: e.target.value })}
                  />
                  <FormInput
                    label={t('settings.ragModel')}
                    value={endpoint.model}
                    onChange={(e) => updateEndpoint(idx, { model: e.target.value })}
                  />
                </div>

                <div className="mt-3">
                  <SecretInput
                    label={endpoint.hasApiKey ? t('settings.ragApiKeyStored') : t('settings.ragApiKey')}
                    value={endpoint.apiKey ?? ''}
                    onChange={(e) => updateEndpoint(idx, { apiKey: e.target.value })}
                    placeholder={endpoint.hasApiKey ? t('settings.ragApiKeyPlaceholderStored') : t('settings.ragApiKeyPlaceholder')}
                  />
                  {endpoint.hasApiKey && endpoint.apiKey === undefined && (
                    <div className="mt-1 text-xs text-gray-500">{t('settings.ragApiKeyKeepHint')}</div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={() => testEndpoint(idx)} disabled={test?.testing === true}>
                    {test?.testing ? t('settings.ragTesting') : t('settings.ragTest')}
                  </Button>
                  {test && !test.testing && (
                    <span className={`text-sm ${test.ok ? 'text-green-300' : 'text-red-300'}`}>
                      {test.ok
                        ? t('settings.ragTestOk', { dimensions: test.dimensions, latency: test.latencyMs })
                        : test.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <SettingsActions>
          <Button onClick={addEndpoint}>{t('settings.ragAddEndpoint')}</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
          <Button variant="secondary" onClick={reindex} disabled={reindexing}>{reindexing ? t('settings.ragReindexing') : t('settings.ragReindexNow')}</Button>
        </SettingsActions>
      </SettingsSection>
    </>
  );
}
