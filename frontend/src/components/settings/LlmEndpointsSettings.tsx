import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  BalancerStatus,
  LlmEndpoint,
  LlmEndpointInput,
  LlmEndpointProvider,
  LlmEndpointPurpose,
} from '../../api/client';
import { matchOption, optionOr } from '../../lib/narrow';
import Button from '../ui/Button';
import { FormInput, FormSelect, SecretInput } from '../ui/FormField';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';
import ChatLlmSettings from './ChatLlmSettings';
import RagSettings from './RagSettings';
import WorkflowAgentSettings from './WorkflowAgentSettings';

const PROVIDERS: LlmEndpointProvider[] = ['openai-compatible', 'anthropic', 'openai', 'ollama'];
const PURPOSES: LlmEndpointPurpose[] = ['chat', 'embedding', 'workflow'];

const PROVIDER_DEFAULT_URL: Record<LlmEndpointProvider, string> = {
  'openai-compatible': 'http://localhost:1234',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  ollama: 'http://localhost:11434',
};

const PROVIDER_DEFAULT_MODEL: Record<LlmEndpointProvider, string> = {
  'openai-compatible': 'google/gemma-3-4b',
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1',
};

/** Fixed Tailwind classes per purpose — never construct class names dynamically. */
const PURPOSE_BADGE_CLASS: Record<LlmEndpointPurpose, string> = {
  chat: 'bg-violet-900/50 text-violet-300 border-violet-800/50',
  embedding: 'bg-cyan-900/50 text-cyan-300 border-cyan-800/50',
  workflow: 'bg-amber-900/50 text-amber-300 border-amber-800/50',
};

const PURPOSE_LABEL_KEY: Record<LlmEndpointPurpose, string> = {
  chat: 'settings.llmPurposeChat',
  embedding: 'settings.llmPurposeEmbedding',
  workflow: 'settings.llmPurposeWorkflow',
};

const HEALTH_BADGE_CLASS = {
  healthy: 'bg-green-900/50 text-green-300 border-green-800/50',
  unhealthy: 'bg-red-900/50 text-red-300 border-red-800/50',
} as const;

function purposeBadgeClass(purpose: string): string {
  const known = matchOption(purpose, PURPOSES);
  return known ? PURPOSE_BADGE_CLASS[known] : 'bg-gray-800 text-gray-400 border-gray-700';
}

interface FormState {
  label: string;
  provider: LlmEndpointProvider;
  baseUrl: string;
  model: string;
  purposes: LlmEndpointPurpose[];
  visionCapable: boolean;
  concurrency: number;
  priority: number;
  timeoutMs: number;
  enabled: boolean;
  /** undefined = keep stored key (edit only), '' = delete, string = set. */
  apiKey?: string;
}

function blankForm(provider: LlmEndpointProvider = 'openai-compatible'): FormState {
  return {
    label: '',
    provider,
    baseUrl: PROVIDER_DEFAULT_URL[provider],
    model: PROVIDER_DEFAULT_MODEL[provider],
    purposes: ['chat'],
    visionCapable: false,
    concurrency: 2,
    priority: 100,
    timeoutMs: 30000,
    enabled: true,
    apiKey: '',
  };
}

function formFromEndpoint(endpoint: LlmEndpoint): FormState {
  return {
    label: endpoint.label,
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    purposes: endpoint.purposes,
    visionCapable: endpoint.visionCapable,
    concurrency: endpoint.concurrency,
    priority: endpoint.priority,
    timeoutMs: endpoint.timeoutMs,
    enabled: endpoint.enabled,
    apiKey: undefined,
  };
}

function buildInput(form: FormState): LlmEndpointInput {
  return {
    label: form.label.trim(),
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    purposes: form.purposes,
    visionCapable: form.visionCapable,
    concurrency: form.concurrency,
    priority: form.priority,
    timeoutMs: form.timeoutMs,
    enabled: form.enabled,
    ...(form.apiKey !== undefined ? { apiKey: form.apiKey } : {}),
  };
}

type TestResult = { ok: boolean; latencyMs?: number; error?: string; testing?: boolean; models?: string[] };

export default function LlmEndpointsSettings() {
  const { t } = useTranslation();

  const [endpoints, setEndpoints] = useState<LlmEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // `'new'` = Formular für einen neuen Endpunkt, sonst die Endpunkt-ID.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [formProbe, setFormProbe] = useState<TestResult | null>(null);

  const [balancer, setBalancer] = useState<BalancerStatus | null>(null);
  const [balancerLoading, setBalancerLoading] = useState(false);
  const [balancerError, setBalancerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.llmEndpoints.list();
      setEndpoints(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorLoading', { error: '' }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const loadBalancer = useCallback(async () => {
    setBalancerLoading(true);
    try {
      const status = await api.balancer.status();
      setBalancer(status);
      setBalancerError(null);
    } catch (e) {
      setBalancerError(e instanceof Error ? e.message : t('settings.llmMonitorLoadError'));
    } finally {
      setBalancerLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadBalancer();
    const interval = setInterval(() => { void loadBalancer(); }, 5000);
    return () => clearInterval(interval);
  }, [loadBalancer]);

  const startCreate = () => {
    setForm(blankForm());
    setEditingId('new');
    setError(null);
    setSuccess(null);
    setFormProbe(null);
  };

  const startEdit = (endpoint: LlmEndpoint) => {
    setForm(formFromEndpoint(endpoint));
    setEditingId(endpoint.id);
    setError(null);
    setSuccess(null);
    setFormProbe(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormProbe(null);
  };

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      // Provider switch: prefill URL/model when the user hadn't customized them yet.
      if (patch.provider && patch.provider !== prev.provider) {
        const wasDefaultUrl = Object.values(PROVIDER_DEFAULT_URL).includes(prev.baseUrl);
        if (!prev.baseUrl || wasDefaultUrl) next.baseUrl = PROVIDER_DEFAULT_URL[patch.provider];
        const wasDefaultModel = Object.values(PROVIDER_DEFAULT_MODEL).includes(prev.model);
        if (!prev.model || wasDefaultModel) next.model = PROVIDER_DEFAULT_MODEL[patch.provider];
      }
      return next;
    });
    setSuccess(null);
  };

  /** Übersetzter Zweck-Name; ein vom Server gemeldeter unbekannter Zweck bleibt roh. */
  const purposeLabel = (purpose: string): string => {
    const known = matchOption(purpose, PURPOSES);
    return known ? t(PURPOSE_LABEL_KEY[known]) : purpose;
  };

  const togglePurpose = (purpose: LlmEndpointPurpose) => {
    setForm((prev) => ({
      ...prev,
      purposes: prev.purposes.includes(purpose)
        ? prev.purposes.filter((p) => p !== purpose)
        : [...prev.purposes, purpose],
    }));
  };

  const saveForm = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || form.purposes.length === 0) {
      setError(t('settings.llmFormValidationError'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildInput(form);
      if (editingId === 'new') {
        await api.llmEndpoints.create(payload);
        setSuccess(t('settings.llmCreated'));
      } else if (editingId) {
        await api.llmEndpoints.update(editingId, payload);
        setSuccess(t('settings.llmUpdated'));
      }
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.llmSaveError'));
    } finally {
      setSaving(false);
    }
  };

  const removeEndpoint = async (endpoint: LlmEndpoint) => {
    if (!window.confirm(t('settings.llmDeleteConfirm', { label: endpoint.label }))) return;
    setError(null);
    setSuccess(null);
    try {
      await api.llmEndpoints.remove(endpoint.id);
      if (editingId === endpoint.id) setEditingId(null);
      setSuccess(t('settings.llmDeleted'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.errorDeleting'));
    }
  };

  const toggleEnabled = async (endpoint: LlmEndpoint) => {
    setError(null);
    try {
      const payload = buildInput({ ...formFromEndpoint(endpoint), enabled: !endpoint.enabled });
      await api.llmEndpoints.update(endpoint.id, payload);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.llmSaveError'));
    }
  };

  const testEndpoint = async (id: string) => {
    setTestResults((prev) => ({ ...prev, [id]: { ok: false, testing: true } }));
    try {
      const result = await api.llmEndpoints.test(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  /** Probe the endpoint currently in the add/edit form (works before saving) and list its models. */
  const probeForm = async () => {
    if (!form.baseUrl.trim()) {
      setFormProbe({ ok: false, error: t('settings.llmProbeNoUrl') });
      return;
    }
    setFormProbe({ ok: false, testing: true });
    const existing = editingId && editingId !== 'new' ? endpoints.find((e) => e.id === editingId) : undefined;
    try {
      const result = await api.llmEndpoints.probe({
        provider: form.provider,
        baseUrl: form.baseUrl,
        // undefined = fall back to the stored key (edit); '' = no key; value = use it.
        apiKey: form.apiKey,
        id: existing?.id,
      });
      setFormProbe(result);
    } catch (e) {
      setFormProbe({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const groupedByPurpose = useMemo<Record<LlmEndpointPurpose, LlmEndpoint[]>>(() => {
    const forPurpose = (purpose: LlmEndpointPurpose) =>
      endpoints
        .filter((endpoint) => endpoint.purposes.includes(purpose))
        .sort((a, b) => a.priority - b.priority);
    return {
      chat: forPurpose('chat'),
      embedding: forPurpose('embedding'),
      workflow: forPurpose('workflow'),
    };
  }, [endpoints]);

  // Shared add/edit form — a plain closure (not a nested component) so re-renders
  // don't remount the inputs and drop focus.
  const renderEndpointForm = () => {
    const isNew = editingId === 'new';
    const existing = !isNew && editingId ? endpoints.find((e) => e.id === editingId) : undefined;
    const hasApiKey = !!existing?.hasApiKey;

    return (
      <div className="rounded-lg border border-violet-500/50 bg-gray-900/80 p-4 space-y-3">
        <div className="text-sm font-medium text-gray-200">
          {isNew ? t('settings.llmFormTitleAdd') : t('settings.llmFormTitleEdit')}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <FormInput
            label={t('settings.llmFormLabel')}
            required
            value={form.label}
            onChange={(e) => updateForm({ label: e.target.value })}
          />
          <FormSelect
            label={t('settings.llmFormProvider')}
            value={form.provider}
            onChange={(e) => updateForm({ provider: optionOr(e.target.value, PROVIDERS, form.provider) })}
          >
            {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </FormSelect>
          <FormInput
            label={t('settings.llmFormModel')}
            required
            value={form.model}
            onChange={(e) => updateForm({ model: e.target.value })}
            placeholder={PROVIDER_DEFAULT_MODEL[form.provider]}
          />
        </div>

        <FormInput
          label={t('settings.llmFormBaseUrl')}
          required
          value={form.baseUrl}
          onChange={(e) => updateForm({ baseUrl: e.target.value })}
          placeholder={PROVIDER_DEFAULT_URL[form.provider]}
        />

        <div>
          <div className="mb-1 text-xs text-gray-500">{t('settings.llmFormPurposes')}</div>
          <div className="flex flex-wrap gap-3">
            {PURPOSES.map((purpose) => (
              <label key={purpose} className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.purposes.includes(purpose)}
                  onChange={() => togglePurpose(purpose)}
                  className="w-3.5 h-3.5 accent-violet-600"
                />
                {t(PURPOSE_LABEL_KEY[purpose])}
              </label>
            ))}
          </div>
        </div>

        <div>
          <SecretInput
            label={hasApiKey ? t('settings.llmApiKeyStored') : t('settings.llmApiKey')}
            value={form.apiKey ?? ''}
            onChange={(e) => updateForm({ apiKey: e.target.value })}
            placeholder={hasApiKey ? t('settings.llmApiKeyPlaceholderStored') : t('settings.llmApiKeyPlaceholder')}
          />
          {hasApiKey && form.apiKey === undefined && (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs text-gray-500">{t('settings.llmApiKeyKeepHint')}</span>
              <button
                type="button"
                onClick={() => updateForm({ apiKey: '' })}
                className="text-xs text-red-400 hover:text-red-300"
              >
                {t('settings.llmApiKeyClear')}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormInput
            label={t('settings.llmFormConcurrency')}
            type="number"
            min={1}
            max={16}
            value={form.concurrency}
            onChange={(e) => updateForm({ concurrency: parseInt(e.target.value, 10) })}
          />
          <FormInput
            label={t('settings.llmFormPriority')}
            type="number"
            min={0}
            value={form.priority}
            onChange={(e) => updateForm({ priority: parseInt(e.target.value, 10) })}
            helpText={t('settings.llmFormPriorityHint')}
          />
          <FormInput
            label={t('settings.llmFormTimeout')}
            type="number"
            min={100}
            step={100}
            value={form.timeoutMs}
            onChange={(e) => updateForm({ timeoutMs: parseInt(e.target.value, 10) })}
          />
          <div className="flex flex-col justify-end gap-2 pb-1">
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.visionCapable}
                onChange={(e) => updateForm({ visionCapable: e.target.checked })}
                className="w-3.5 h-3.5 accent-violet-600"
              />
              {t('settings.llmFormVision')}
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => updateForm({ enabled: e.target.checked })}
                className="w-3.5 h-3.5 accent-violet-600"
              />
              {t('settings.llmFormEnabled')}
            </label>
          </div>
        </div>

        {error && <div className="rounded border border-red-700 bg-red-900/50 px-3 py-2 text-xs text-red-300">{error}</div>}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => { void saveForm(); }} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => { void probeForm(); }} disabled={formProbe?.testing === true}>
              {formProbe?.testing ? t('settings.llmProbing') : t('settings.llmProbe')}
            </Button>
            {formProbe && !formProbe.testing && (
              <span className={`text-xs ${formProbe.ok ? 'text-green-300' : 'text-red-300'}`}>
                {formProbe.ok
                  ? t('settings.llmProbeOk', { latency: formProbe.latencyMs ?? 0, count: formProbe.models?.length ?? 0 })
                  : t('settings.llmTestFail', { error: formProbe.error })}
              </span>
            )}
          </div>
          {formProbe?.ok && (formProbe.models?.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 text-xs text-gray-500">{t('settings.llmProbeModelsHint')}</div>
              <div className="flex flex-wrap gap-1.5">
                {formProbe.models!.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateForm({ model: m })}
                    className={
                      form.model === m
                        ? 'rounded border border-violet-400 bg-violet-600/30 px-2 py-0.5 text-xs text-violet-100'
                        : 'rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-300 hover:border-violet-500 hover:text-violet-200'
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
          {formProbe?.ok && (formProbe.models?.length ?? 0) === 0 && (
            <div className="text-xs text-gray-500">{t('settings.llmProbeNoModels')}</div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsTabHeader description={t('settings.llmEndpointsPageDescription')} />

      {error && editingId === null && (
        <div className="mb-4 rounded border border-red-700 bg-red-900/50 px-4 py-2 text-red-300">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded border border-green-700 bg-green-900/40 px-4 py-2 text-green-300">{success}</div>
      )}

      <div className="space-y-6">
        <SettingsSection
          title={t('settings.llmEndpointsTitle')}
          description={t('settings.llmEndpointsDescription')}
          meta={endpoints.length > 0 ? `${endpoints.length}` : undefined}
        >
          <div className="space-y-3">
            {endpoints.length === 0 && editingId !== 'new' && (
              <div className="text-gray-500 text-sm py-4 text-center">{t('settings.llmNoEndpoints')}</div>
            )}

            {endpoints.map((endpoint) => {
              if (editingId === endpoint.id) {
                return <div key={endpoint.id}>{renderEndpointForm()}</div>;
              }
              const test = testResults[endpoint.id];
              return (
                <div key={endpoint.id} className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">{endpoint.label}</span>
                        <span className="text-xs text-gray-500">{endpoint.provider}</span>
                        {endpoint.hasApiKey && (
                          <span title={t('settings.llmApiKeyStored')} className="text-xs text-amber-400">🔑</span>
                        )}
                        {endpoint.visionCapable && (
                          <span className="rounded-full border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                            {t('settings.llmVisionBadge')}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500 truncate">{endpoint.baseUrl} · {endpoint.model}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {endpoint.purposes.map((purpose) => (
                          <span
                            key={purpose}
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${purposeBadgeClass(purpose)}`}
                          >
                            {t(PURPOSE_LABEL_KEY[purpose])}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-3 text-xs text-gray-500">
                      <span>{t('settings.llmFormConcurrency')}: {endpoint.concurrency}</span>
                      <span>{t('common.priority')}: {endpoint.priority}</span>
                      <button
                        type="button"
                        onClick={() => { void toggleEnabled(endpoint); }}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          endpoint.enabled
                            ? 'bg-green-900/50 text-green-300 hover:bg-green-800/50'
                            : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                        }`}
                      >
                        {endpoint.enabled ? t('settings.llmEnabled') : t('settings.llmDisabled')}
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button size="sm" onClick={() => { void testEndpoint(endpoint.id); }} disabled={test?.testing === true}>
                      {test?.testing ? t('settings.llmTesting') : t('settings.llmTest')}
                    </Button>
                    <Button size="sm" onClick={() => startEdit(endpoint)}>{t('common.edit')}</Button>
                    <Button size="sm" variant="danger" onClick={() => { void removeEndpoint(endpoint); }}>{t('common.remove')}</Button>
                    {test && !test.testing && (
                      <span className={`text-xs ${test.ok ? 'text-green-300' : 'text-red-300'}`}>
                        {test.ok ? t('settings.llmTestOk', { latency: test.latencyMs }) : t('settings.llmTestFail', { error: test.error })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {editingId === 'new' && renderEndpointForm()}
          </div>

          {editingId === null && (
            <SettingsActions>
              <Button onClick={startCreate}>{t('settings.llmAddEndpoint')}</Button>
            </SettingsActions>
          )}
        </SettingsSection>

        <SettingsSection title={t('settings.llmUsageTitle')} description={t('settings.llmUsageDescription')}>
          <div className="grid gap-4 md:grid-cols-3">
            {PURPOSES.map((purpose) => (
              <div key={purpose} className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PURPOSE_BADGE_CLASS[purpose]}`}>
                    {t(PURPOSE_LABEL_KEY[purpose])}
                  </span>
                  <span className="text-xs text-gray-500">{groupedByPurpose[purpose].length}</span>
                </div>
                {groupedByPurpose[purpose].length === 0 ? (
                  <div className="text-xs text-gray-600">{t('settings.llmUsageNoEndpoints')}</div>
                ) : (
                  <ol className="space-y-1">
                    {groupedByPurpose[purpose].map((endpoint, idx) => (
                      <li key={endpoint.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="text-gray-600">{idx + 1}.</span>
                          <span className={`truncate ${endpoint.enabled ? 'text-gray-200' : 'text-gray-600 line-through'}`}>
                            {endpoint.label}
                          </span>
                        </span>
                        <span className="shrink-0 text-gray-500">{t('common.priority')} {endpoint.priority}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection title={t('settings.llmMonitorTitle')} description={t('settings.llmMonitorDescription')}>
          <div className="mb-3 flex items-center justify-between gap-3">
            {balancerError && <span className="text-xs text-red-300">{balancerError}</span>}
            <Button size="sm" onClick={() => { void loadBalancer(); }} disabled={balancerLoading} className="ml-auto">
              {balancerLoading ? t('common.loading') : t('settings.llmMonitorRefresh')}
            </Button>
          </div>

          {!balancer ? (
            <div className="text-gray-500 text-sm py-4 text-center">
              {balancerLoading ? t('common.loading') : t('settings.llmMonitorLoadError')}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">{t('settings.llmMonitorPool')}</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {balancer.pools.map((pool) => (
                    <div key={pool.purpose} className="rounded border border-gray-800 bg-gray-950/40 p-2.5 text-xs">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${purposeBadgeClass(pool.purpose)}`}>
                        {purposeLabel(pool.purpose)}
                      </span>
                      <div className="mt-2 grid grid-cols-3 gap-1 text-gray-400">
                        <div>
                          <div className="text-gray-600">{t('settings.llmMonitorCapacity')}</div>
                          <div className="text-gray-200">{pool.capacity}</div>
                        </div>
                        <div>
                          <div className="text-gray-600">{t('settings.llmMonitorWaiting')}</div>
                          <div className="text-gray-200">{pool.waiting}</div>
                        </div>
                        <div>
                          <div className="text-gray-600">{t('settings.llmMonitorActive')}</div>
                          <div className="text-gray-200">{pool.active}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {balancer.pools.length === 0 && <div className="text-xs text-gray-600">{t('settings.llmUsageNoEndpoints')}</div>}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">{t('settings.llmMonitorEndpoint')}</div>
                <div className="space-y-1.5">
                  {balancer.endpoints.map((endpoint) => (
                    <div key={endpoint.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-800 bg-gray-950/40 px-2.5 py-1.5 text-xs">
                      <span className="truncate text-gray-200">{endpoint.label}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-gray-500">{t('settings.llmMonitorInFlight')}: {endpoint.inFlight}/{endpoint.concurrency}</span>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${
                            endpoint.healthy ? HEALTH_BADGE_CLASS.healthy : HEALTH_BADGE_CLASS.unhealthy
                          }`}
                        >
                          {endpoint.healthy ? t('settings.llmMonitorHealthy') : t('settings.llmMonitorUnhealthy')}
                        </span>
                      </div>
                    </div>
                  ))}
                  {balancer.endpoints.length === 0 && <div className="text-xs text-gray-600">{t('settings.llmUsageNoEndpoints')}</div>}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">{t('settings.llmMonitorQueue')}</div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                    <div className="text-gray-600">{t('settings.llmMonitorQueueWaiting')}</div>
                    <div className="text-gray-200">{balancer.queue.waiting}</div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                    <div className="text-gray-600">{t('settings.llmMonitorQueueActive')}</div>
                    <div className="text-gray-200">{balancer.queue.active}</div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                    <div className="text-gray-600">{t('settings.llmMonitorQueueDelayed')}</div>
                    <div className="text-gray-200">{balancer.queue.delayed}</div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                    <div className="text-gray-600">{t('settings.llmMonitorQueueCompleted')}</div>
                    <div className="text-gray-200">{balancer.queue.completed}</div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                    <div className="text-gray-600">{t('settings.llmMonitorQueueFailed')}</div>
                    <div className="text-gray-200">{balancer.queue.failed}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </SettingsSection>

        <div className="border-t border-gray-800 pt-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-cyan-400">{t('settings.llmBehaviorOptionsTitle')}</h2>
            <p className="mt-1 text-sm text-gray-500">{t('settings.llmBehaviorOptionsDescription')}</p>
          </div>
          <div className="space-y-6">
            <ChatLlmSettings />
            <RagSettings />
            <WorkflowAgentSettings />
          </div>
        </div>
      </div>
    </>
  );
}
