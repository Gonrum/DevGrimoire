import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, SetWebSearchConfig, SetWebSearchProvider, WebSearchProviderType } from '../api/client';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect, SecretInput } from './ui/FormField';
import { SettingsActions, SettingsSection } from './ui/SettingsShell';

const PROVIDER_TYPES: WebSearchProviderType[] = ['searxng', 'tavily', 'brave', 'serpapi'];

const PROVIDER_LABEL_KEY: Record<WebSearchProviderType, string> = {
  searxng: 'settings.webSearch.providerSearxng',
  tavily: 'settings.webSearch.providerTavily',
  brave: 'settings.webSearch.providerBrave',
  serpapi: 'settings.webSearch.providerSerpapi',
};

const PROVIDER_DEFAULT_URL: Record<WebSearchProviderType, string> = {
  searxng: 'http://searxng:8080',
  tavily: 'https://api.tavily.com',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  serpapi: 'https://serpapi.com/search',
};

interface ProviderFormEntry {
  baseUrl: string;
  /** undefined = keep stored key, '' = delete key, non-empty = set key. */
  apiKey?: string;
  hasApiKey: boolean;
}

function blankProviderEntry(): ProviderFormEntry {
  return { baseUrl: '', apiKey: undefined, hasApiKey: false };
}

function blankProviderForms(): Record<WebSearchProviderType, ProviderFormEntry> {
  return {
    searxng: blankProviderEntry(),
    tavily: blankProviderEntry(),
    brave: blankProviderEntry(),
    serpapi: blankProviderEntry(),
  };
}

type ProviderTestResult = { ok: boolean; count?: number; error?: string; testing?: boolean };

interface WebSearchSettingsState {
  enabled: string;
  searxngUrl: string;
  defaultLanguage: string;
  cacheTtlHours: string;
  contentCacheTtlDays: string;
  maxResults: string;
}

const SETTING_KEYS: Record<keyof WebSearchSettingsState, string> = {
  enabled: 'web_search_enabled',
  searxngUrl: 'web_search_searxng_url',
  defaultLanguage: 'web_search_default_language',
  cacheTtlHours: 'web_search_cache_ttl_hours',
  contentCacheTtlDays: 'web_search_content_cache_ttl_days',
  maxResults: 'web_search_max_results',
};

const DEFAULTS: WebSearchSettingsState = {
  enabled: 'true',
  searxngUrl: 'http://searxng:8080',
  defaultLanguage: 'de',
  cacheTtlHours: '24',
  contentCacheTtlDays: '7',
  maxResults: '10',
};

type Health = { enabled: boolean; searxng: { ok: boolean; url: string; error?: string } } | null;
type Stats = {
  search: { cached: number; oldestEntry?: string };
  fetch: { cached: number; oldestEntry?: string };
} | null;

export default function WebSearchSettings() {
  const { t } = useTranslation();
  const [values, setValues] = useState<WebSearchSettingsState>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [health, setHealth] = useState<Health>(null);
  const [stats, setStats] = useState<Stats>(null);
  const [clearing, setClearing] = useState(false);

  const [activeProvider, setActiveProvider] = useState<WebSearchProviderType>('searxng');
  const [providerForms, setProviderForms] = useState<Record<WebSearchProviderType, ProviderFormEntry>>(blankProviderForms());
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);
  const [providerTests, setProviderTests] = useState<Partial<Record<WebSearchProviderType, ProviderTestResult>>>({});
  const [advancedOpen, setAdvancedOpen] = useState<Record<WebSearchProviderType, boolean>>({
    searxng: false,
    tavily: false,
    brave: false,
    serpapi: false,
  });

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(
        (Object.entries(SETTING_KEYS) as [keyof WebSearchSettingsState, string][]).map(
          async ([field, key]) => [field, (await api.settings.get(key)).value ?? DEFAULTS[field]] as const,
        ),
      );
      const next = { ...DEFAULTS };
      for (const [field, value] of entries) next[field] = value;
      setValues(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api.webSearch.health(), api.webSearch.stats()]);
      setHealth(h);
      setStats(s);
    } catch {
      // Health/stats are optional info — don't block the settings UI
    }
  }, []);

  const loadProviderConfig = useCallback(async () => {
    setProviderLoading(true);
    setProviderError(null);
    try {
      const cfg = await api.webSearch.getConfig();
      setActiveProvider(cfg.activeProvider);
      const next = blankProviderForms();
      for (const p of cfg.providers) {
        next[p.type] = { baseUrl: p.baseUrl ?? '', apiKey: undefined, hasApiKey: p.hasApiKey };
      }
      setProviderForms(next);
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : 'Failed to load provider config');
    } finally {
      setProviderLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadHealth();
    loadProviderConfig();
  }, [loadSettings, loadHealth, loadProviderConfig]);

  const updateProviderField = (type: WebSearchProviderType, patch: Partial<ProviderFormEntry>) => {
    setProviderForms((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
    setProviderSuccess(null);
  };

  const testProviderConfig = async (type: WebSearchProviderType) => {
    setProviderTests((prev) => ({ ...prev, [type]: { ok: false, testing: true } }));
    const entry = providerForms[type];
    try {
      const result = await api.webSearch.testConfig({
        type,
        baseUrl: entry.baseUrl.trim() || undefined,
        apiKey: entry.apiKey,
      });
      setProviderTests((prev) => ({ ...prev, [type]: result }));
    } catch (e) {
      setProviderTests((prev) => ({
        ...prev,
        [type]: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const saveProviderConfig = async () => {
    setProviderSaving(true);
    setProviderError(null);
    setProviderSuccess(null);
    try {
      const payload: SetWebSearchConfig = {
        activeProvider,
        providers: PROVIDER_TYPES.map((type): SetWebSearchProvider => {
          const entry = providerForms[type];
          const provider: SetWebSearchProvider = { type };
          if (entry.baseUrl.trim()) provider.baseUrl = entry.baseUrl.trim();
          if (entry.apiKey !== undefined) provider.apiKey = entry.apiKey;
          return provider;
        }),
      };
      const result = await api.webSearch.setConfig(payload);
      setActiveProvider(result.activeProvider);
      const next = blankProviderForms();
      for (const p of result.providers) {
        next[p.type] = { baseUrl: p.baseUrl ?? '', apiKey: undefined, hasApiKey: p.hasApiKey };
      }
      setProviderForms(next);
      setProviderSuccess(t('common.saved'));
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : t('common.errorSaving'));
    } finally {
      setProviderSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await Promise.all(
        (Object.entries(SETTING_KEYS) as [keyof WebSearchSettingsState, string][]).map(
          ([field, key]) => api.settings.set(key, values[field]),
        ),
      );
      setSuccess(t('common.saved'));
      await loadHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const clearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      const res = await api.webSearch.clearCache();
      setSuccess(t('settings.webSearch.cacheCleared', {
        search: res.search.deleted,
        fetch: res.fetch.deleted,
      }));
      await loadHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear cache');
    } finally {
      setClearing(false);
    }
  };

  if (loading) {
    return <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>;
  }

  const enabledBool = values.enabled.toLowerCase() === 'true';

  return (
    <div className="space-y-6">
      <p className="text-gray-400">{t('settings.webSearch.description')}</p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/30 border border-green-700 text-green-300 px-4 py-2 rounded">
          {success}
        </div>
      )}

      {health && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-2">{t('settings.webSearch.health')}</h3>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                health.searxng.ok ? 'bg-green-400' : 'bg-red-400'
              }`}
            />
            <span className="text-gray-300">{health.searxng.url}</span>
            {!health.searxng.ok && health.searxng.error && (
              <span className="text-red-400 text-xs">— {health.searxng.error}</span>
            )}
          </div>
          {stats && (
            <div className="mt-2 text-xs text-gray-400">
              {t('settings.webSearch.cacheStats', {
                search: stats.search.cached,
                fetch: stats.fetch.cached,
              })}
            </div>
          )}
        </div>
      )}

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabledBool}
          onChange={(e) => setValues({ ...values, enabled: e.target.checked ? 'true' : 'false' })}
          className="w-4 h-4 accent-cyan-500"
        />
        <span className="text-gray-200">{t('settings.webSearch.enabled')}</span>
      </label>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          {t('settings.webSearch.searxngUrl')}
        </label>
        <input
          type="text"
          value={values.searxngUrl}
          onChange={(e) => setValues({ ...values, searxngUrl: e.target.value })}
          placeholder="http://searxng:8080"
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t('settings.webSearch.defaultLanguage')}
          </label>
          <input
            type="text"
            value={values.defaultLanguage}
            onChange={(e) => setValues({ ...values, defaultLanguage: e.target.value })}
            placeholder="de"
            maxLength={5}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t('settings.webSearch.maxResults')}
          </label>
          <input
            type="number"
            min={1}
            max={20}
            value={values.maxResults}
            onChange={(e) => setValues({ ...values, maxResults: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t('settings.webSearch.cacheTtlHours')}
          </label>
          <input
            type="number"
            min={1}
            value={values.cacheTtlHours}
            onChange={(e) => setValues({ ...values, cacheTtlHours: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t('settings.webSearch.contentCacheTtlDays')}
          </label>
          <input
            type="number"
            min={1}
            value={values.contentCacheTtlDays}
            onChange={(e) => setValues({ ...values, contentCacheTtlDays: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button variant="primary" size="lg" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <ConfirmButton
          size="lg"
          variant="danger"
          onConfirm={clearCache}
          disabled={clearing}
          label={clearing ? t('common.loading') : t('settings.webSearch.clearCache')}
          confirmLabel={t('settings.webSearch.confirmClearCache')}
        />
      </div>

      <SettingsSection
        title={t('settings.webSearch.providerTitle')}
        description={t('settings.webSearch.providerDescription')}
      >
        {providerLoading ? (
          <div className="text-gray-500 py-6 text-center text-sm">{t('common.loading')}</div>
        ) : (
          <>
            {providerError && (
              <div className="mb-4 rounded border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">
                {providerError}
              </div>
            )}
            {providerSuccess && (
              <div className="mb-4 rounded border border-green-700 bg-green-900/40 px-4 py-2 text-sm text-green-300">
                {providerSuccess}
              </div>
            )}

            <FormSelect
              label={t('settings.webSearch.activeProvider')}
              value={activeProvider}
              onChange={(e) => {
                setActiveProvider(e.target.value as WebSearchProviderType);
                setProviderSuccess(null);
              }}
              fieldClassName="mb-4 max-w-xs"
            >
              {PROVIDER_TYPES.map((type) => (
                <option key={type} value={type}>{t(PROVIDER_LABEL_KEY[type])}</option>
              ))}
            </FormSelect>

            <div className="space-y-3">
              {PROVIDER_TYPES.map((type) => {
                const entry = providerForms[type];
                const test = providerTests[type];
                const isActive = activeProvider === type;
                return (
                  <div
                    key={type}
                    className={`rounded-lg border p-4 ${
                      isActive ? 'border-cyan-700/60 bg-cyan-950/10' : 'border-gray-800 bg-gray-950/40'
                    }`}
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200">{t(PROVIDER_LABEL_KEY[type])}</span>
                        {isActive && (
                          <span className="rounded-full border border-cyan-700/50 bg-cyan-900/40 px-2 py-0.5 text-[11px] text-cyan-300">
                            {t('settings.webSearch.activeBadge')}
                          </span>
                        )}
                      </div>
                      {entry.hasApiKey && (
                        <span title={t('settings.webSearch.apiKeyStored')} className="text-xs text-amber-400">🔑</span>
                      )}
                    </div>

                    {type === 'searxng' ? (
                      <FormInput
                        label={t('settings.webSearch.providerBaseUrl')}
                        value={entry.baseUrl}
                        onChange={(e) => updateProviderField(type, { baseUrl: e.target.value })}
                        placeholder={PROVIDER_DEFAULT_URL[type]}
                      />
                    ) : (
                      <div className="space-y-2">
                        <SecretInput
                          label={t('settings.webSearch.providerApiKey')}
                          value={entry.apiKey ?? ''}
                          onChange={(e) => updateProviderField(type, { apiKey: e.target.value })}
                          placeholder={entry.hasApiKey ? '••••••' : t('settings.webSearch.apiKeyPlaceholder')}
                        />
                        {entry.hasApiKey && entry.apiKey === undefined && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">{t('settings.webSearch.apiKeyKeepHint')}</span>
                            <button
                              type="button"
                              onClick={() => updateProviderField(type, { apiKey: '' })}
                              className="text-xs text-red-400 hover:text-red-300"
                            >
                              {t('settings.webSearch.apiKeyClear')}
                            </button>
                          </div>
                        )}
                        {advancedOpen[type] || entry.baseUrl.trim() ? (
                          <FormInput
                            label={t('settings.webSearch.providerBaseUrlOverride')}
                            value={entry.baseUrl}
                            onChange={(e) => updateProviderField(type, { baseUrl: e.target.value })}
                            placeholder={PROVIDER_DEFAULT_URL[type]}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAdvancedOpen((prev) => ({ ...prev, [type]: true }))}
                            className="text-xs text-gray-500 hover:text-gray-300"
                          >
                            {t('settings.webSearch.advancedEndpoint')}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Button size="sm" onClick={() => testProviderConfig(type)} disabled={test?.testing === true}>
                        {test?.testing ? t('settings.webSearch.testing') : t('settings.webSearch.test')}
                      </Button>
                      {test && !test.testing && (
                        <span className={`text-xs ${test.ok ? 'text-green-300' : 'text-red-300'}`}>
                          {test.ok
                            ? t('settings.webSearch.testOk', { count: test.count ?? 0 })
                            : t('settings.webSearch.testFail', { error: test.error })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <SettingsActions>
              <Button variant="primary" onClick={saveProviderConfig} disabled={providerSaving}>
                {providerSaving ? t('common.saving') : t('common.save')}
              </Button>
            </SettingsActions>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
