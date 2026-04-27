import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';

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

  useEffect(() => {
    loadSettings();
    loadHealth();
  }, [loadSettings, loadHealth]);

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
    </div>
  );
}
