import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  Customer,
  Project,
  ResearchFrequency,
  ResearchTopicDetail,
  UpdateResearchTopicPayload,
  WebSearchProviderType,
} from '../../api/client';
import { useToast } from '../Toast';
import Button from '../ui/Button';
import DetailSection from '../ui/DetailSection';
import { FormInput, FormSelect, FormTextarea } from '../ui/FormField';
import Switch from '../ui/Switch';

const FREQUENCIES: ResearchFrequency[] = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

const WEB_SEARCH_PROVIDERS: WebSearchProviderType[] = ['searxng', 'tavily', 'brave', 'serpapi'];

// Mirrors CreateTopicDialog.tsx's local provider label map (same reasoning:
// not exported from WebSearchSettings.tsx, so each caller keeps its own
// small const rather than importing an internal detail of an unrelated
// settings component).
const PROVIDER_LABEL_KEY: Record<WebSearchProviderType, string> = {
  searxng: 'settings.webSearch.providerSearxng',
  tavily: 'settings.webSearch.providerTavily',
  brave: 'settings.webSearch.providerBrave',
  serpapi: 'settings.webSearch.providerSerpapi',
};

const checkboxClass = 'rounded border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500';
const radioClass = 'border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500';

interface FormState {
  brief: string;
  scopeMode: 'all' | 'selected';
  selectedProjectIds: Set<string>;
  selectedCustomerIds: Set<string>;
  includeGlobal: boolean;
  frequency: ResearchFrequency;
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  scheduleActive: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: string;
  maxIterations: number;
  maxWebSearches: number;
  maxWebFetches: number;
  timeoutMs: number;
  notifyOnComplete: boolean;
}

function formFromTopic(topic: ResearchTopicDetail): FormState {
  return {
    brief: topic.brief,
    scopeMode: topic.scope.mode,
    selectedProjectIds: new Set(topic.scope.projectIds),
    selectedCustomerIds: new Set(topic.scope.customerIds),
    includeGlobal: topic.scope.includeGlobal,
    frequency: topic.schedule.frequency,
    hour: topic.schedule.hour,
    dayOfWeek: topic.schedule.dayOfWeek ?? 1,
    dayOfMonth: topic.schedule.dayOfMonth ?? 1,
    scheduleActive: topic.schedule.active,
    webSearchEnabled: topic.webSearch.enabled,
    webSearchProvider: topic.webSearch.provider ?? '',
    maxIterations: topic.guardrails.maxIterations,
    maxWebSearches: topic.guardrails.maxWebSearches,
    maxWebFetches: topic.guardrails.maxWebFetches,
    timeoutMs: topic.guardrails.timeoutMs,
    notifyOnComplete: topic.notifyOnComplete,
  };
}

interface TopicSettingsProps {
  topic: ResearchTopicDetail;
  projects: Project[];
  customers: Customer[];
  onSaved: (updated: ResearchTopicDetail) => void;
}

/**
 * Edits everything about a topic EXCEPT its title (owned by the page
 * header's inline editor — see `ResearchTopicPage.tsx`): brief, scope,
 * schedule, web-search provider override, guardrails, notify-on-complete.
 * Field set mirrors `CreateTopicDialog.tsx` closely (same underlying DTO
 * shape), minus the title field, plus `notifyOnComplete`.
 */
export default function TopicSettings({ topic, projects, customers, onSaved }: TopicSettingsProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [form, setForm] = useState<FormState>(() => formFromTopic(topic));
  const [saving, setSaving] = useState(false);

  // Reset local edits only when navigating to a DIFFERENT topic — a
  // concurrent header title save (which patches the same `topic` object in
  // the parent) should not clobber in-progress settings edits.
  useEffect(() => {
    setForm(formFromTopic(topic));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic._id]);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const toggleProject = (id: string) =>
    setForm((f) => {
      const next = new Set(f.selectedProjectIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, selectedProjectIds: next };
    });

  const toggleCustomer = (id: string) =>
    setForm((f) => {
      const next = new Set(f.selectedCustomerIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, selectedCustomerIds: next };
    });

  const showDayOfWeek = form.frequency === 'weekly' || form.frequency === 'biweekly';
  const showDayOfMonth = form.frequency === 'monthly' || form.frequency === 'quarterly' || form.frequency === 'yearly';

  const canSave = form.brief.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: UpdateResearchTopicPayload = {
        brief: form.brief.trim(),
        scope: {
          mode: form.scopeMode,
          projectIds: form.scopeMode === 'selected' ? [...form.selectedProjectIds] : [],
          customerIds: form.scopeMode === 'selected' ? [...form.selectedCustomerIds] : [],
          includeGlobal: form.includeGlobal,
        },
        webSearch: {
          enabled: form.webSearchEnabled,
          provider: form.webSearchEnabled && form.webSearchProvider ? form.webSearchProvider : undefined,
        },
        schedule: {
          frequency: form.frequency,
          hour: form.hour,
          dayOfWeek: showDayOfWeek ? form.dayOfWeek : undefined,
          dayOfMonth: showDayOfMonth ? form.dayOfMonth : undefined,
          active: form.scheduleActive,
        },
        guardrails: {
          maxIterations: form.maxIterations,
          maxWebSearches: form.maxWebSearches,
          maxWebFetches: form.maxWebFetches,
          timeoutMs: form.timeoutMs,
        },
        notifyOnComplete: form.notifyOnComplete,
      };
      const updated = await api.researchTopics.update(topic._id, payload);
      showSuccess(t('researchTopics.settingsSaved'));
      onSaved(updated);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.settingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <FormTextarea
        fieldClassName="w-full"
        label={t('researchTopics.briefLabel')}
        required
        rows={4}
        value={form.brief}
        onChange={(e) => update({ brief: e.target.value })}
        placeholder={t('researchTopics.briefPlaceholder')}
      />

      <DetailSection title={t('researchTopics.scopeLabel')}>
        <div className="flex gap-4 mb-2">
          <label className="flex items-center gap-1.5 text-sm text-gray-200 cursor-pointer">
            <input type="radio" name="scopeMode" checked={form.scopeMode === 'all'} onChange={() => update({ scopeMode: 'all' })} className={radioClass} />
            {t('researchTopics.scopeModeAll')}
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-200 cursor-pointer">
            <input type="radio" name="scopeMode" checked={form.scopeMode === 'selected'} onChange={() => update({ scopeMode: 'selected' })} className={radioClass} />
            {t('researchTopics.scopeModeSelected')}
          </label>
        </div>

        {form.scopeMode === 'selected' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
            <div>
              <p className="text-xs text-gray-500 mb-1">{t('researchTopics.scopeProjectsLabel')}</p>
              <div className="max-h-40 overflow-y-auto space-y-1 border border-gray-800 rounded-lg p-2">
                {projects.length === 0 ? (
                  <p className="text-xs text-gray-500 px-2 py-1">{t('researchTopics.noProjects')}</p>
                ) : (
                  projects.map((p) => (
                    <label key={p._id} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer text-sm text-gray-200">
                      <input type="checkbox" checked={form.selectedProjectIds.has(p._id)} onChange={() => toggleProject(p._id)} className={checkboxClass} />
                      <span>{p.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">{t('researchTopics.scopeCustomersLabel')}</p>
              <div className="max-h-40 overflow-y-auto space-y-1 border border-gray-800 rounded-lg p-2">
                {customers.length === 0 ? (
                  <p className="text-xs text-gray-500 px-2 py-1">{t('researchTopics.noCustomers')}</p>
                ) : (
                  customers.map((c) => (
                    <label key={c._id} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer text-sm text-gray-200">
                      <input type="checkbox" checked={form.selectedCustomerIds.has(c._id)} onChange={() => toggleCustomer(c._id)} className={checkboxClass} />
                      <span>{c.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
          <input type="checkbox" checked={form.includeGlobal} onChange={(e) => update({ includeGlobal: e.target.checked })} className={checkboxClass} />
          {t('researchTopics.scopeIncludeGlobal')}
        </label>
      </DetailSection>

      <DetailSection title={t('researchTopics.scheduleLabel')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <FormSelect
            fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
            label={t('recurringTasks.frequency')}
            value={form.frequency}
            onChange={(e) => update({ frequency: e.target.value as ResearchFrequency })}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>{t(`recurringTasks.freq_${f}`)}</option>
            ))}
          </FormSelect>

          {showDayOfWeek && (
            <FormSelect
              fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
              label={t('recurringTasks.dayOfWeek')}
              value={String(form.dayOfWeek)}
              onChange={(e) => update({ dayOfWeek: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <option key={d} value={d}>{t(`recurringTasks.day_${d}`)}</option>
              ))}
            </FormSelect>
          )}

          {showDayOfMonth && (
            <FormSelect
              fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
              label={t('recurringTasks.dayOfMonth')}
              value={String(form.dayOfMonth)}
              onChange={(e) => update({ dayOfMonth: Number(e.target.value) })}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}.</option>
              ))}
            </FormSelect>
          )}

          <FormSelect
            fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
            label={t('recurringTasks.hour')}
            value={String(form.hour)}
            onChange={(e) => update({ hour: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, i) => i).map((h) => (
              <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
            ))}
          </FormSelect>
        </div>

        <label className="flex items-center gap-2 mt-3 text-sm text-gray-200">
          <Switch checked={form.scheduleActive} onChange={(v) => update({ scheduleActive: v })} label={t('researchTopics.scheduleActive')} />
          {t('researchTopics.scheduleActive')}
        </label>
      </DetailSection>

      <DetailSection title={t('researchTopics.webSearchLabel')}>
        <label className="flex items-center gap-2 text-sm text-gray-200">
          <Switch checked={form.webSearchEnabled} onChange={(v) => update({ webSearchEnabled: v })} label={t('settings.webSearch.enabled')} />
          {t('settings.webSearch.enabled')}
        </label>
        {form.webSearchEnabled && (
          <FormSelect
            fieldClassName="w-full sm:w-64 mt-2"
            label={t('settings.webSearch.providerTitle')}
            value={form.webSearchProvider}
            onChange={(e) => update({ webSearchProvider: e.target.value })}
          >
            <option value="">{t('researchTopics.webSearchProviderDefault')}</option>
            {WEB_SEARCH_PROVIDERS.map((p) => (
              <option key={p} value={p}>{t(PROVIDER_LABEL_KEY[p])}</option>
            ))}
          </FormSelect>
        )}
      </DetailSection>

      <DetailSection title={t('researchTopics.notifyOnCompleteLabel')}>
        <Switch checked={form.notifyOnComplete} onChange={(v) => update({ notifyOnComplete: v })} label={t('researchTopics.notifyOnCompleteLabel')} />
      </DetailSection>

      <DetailSection title={t('researchTopics.guardrailsLabel')}>
        <div className="grid grid-cols-2 gap-3">
          <FormInput type="number" min={1} label={t('researchTopics.guardrailsMaxIterations')} value={form.maxIterations} onChange={(e) => update({ maxIterations: Number(e.target.value) })} />
          <FormInput type="number" min={1} label={t('researchTopics.guardrailsMaxWebSearches')} value={form.maxWebSearches} onChange={(e) => update({ maxWebSearches: Number(e.target.value) })} />
          <FormInput type="number" min={1} label={t('researchTopics.guardrailsMaxWebFetches')} value={form.maxWebFetches} onChange={(e) => update({ maxWebFetches: Number(e.target.value) })} />
          <FormInput type="number" min={1000} step={1000} label={t('researchTopics.guardrailsTimeoutMs')} value={form.timeoutMs} onChange={(e) => update({ timeoutMs: Number(e.target.value) })} />
        </div>
      </DetailSection>

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="primary" size="md" disabled={saving || !canSave} onClick={handleSave}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}
