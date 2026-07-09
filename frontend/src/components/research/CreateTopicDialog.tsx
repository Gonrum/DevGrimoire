import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  Customer,
  CreateResearchTopicPayload,
  Project,
  ResearchFrequency,
  WebSearchProviderType,
} from '../../api/client';
import { useToast } from '../Toast';
import Button from '../ui/Button';
import { Dialog, Portal } from '../ui/Dialog';
import { FormInput, FormSelect, FormTextarea } from '../ui/FormField';
import Switch from '../ui/Switch';

const FREQUENCIES: ResearchFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
];

const WEB_SEARCH_PROVIDERS: WebSearchProviderType[] = ['searxng', 'tavily', 'brave', 'serpapi'];

// Mirrors `WebSearchSettings.tsx`'s local provider label map (not exported
// from there) — kept as its own small const rather than importing an
// internal detail of an unrelated settings component.
const PROVIDER_LABEL_KEY: Record<WebSearchProviderType, string> = {
  searxng: 'settings.webSearch.providerSearxng',
  tavily: 'settings.webSearch.providerTavily',
  brave: 'settings.webSearch.providerBrave',
  serpapi: 'settings.webSearch.providerSerpapi',
};

const checkboxClass =
  'rounded border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500';
const radioClass = 'border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500';

interface CreateTopicDialogProps {
  projects: Project[];
  customers: Customer[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}

export default function CreateTopicDialog({
  projects,
  customers,
  onCancel,
  onCreated,
}: CreateTopicDialogProps) {
  const { t } = useTranslation();
  const { showError } = useToast();

  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');

  const [scopeMode, setScopeMode] = useState<'all' | 'selected'>('all');
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [includeGlobal, setIncludeGlobal] = useState(true);

  const [frequency, setFrequency] = useState<ResearchFrequency>('weekly');
  const [hour, setHour] = useState(9);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [scheduleActive, setScheduleActive] = useState(true);

  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState('');

  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const [maxIterations, setMaxIterations] = useState(12);
  const [maxWebSearches, setMaxWebSearches] = useState(6);
  const [maxWebFetches, setMaxWebFetches] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(300000);

  const [saving, setSaving] = useState(false);

  const showDayOfWeek = frequency === 'weekly' || frequency === 'biweekly';
  const showDayOfMonth = frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly';

  const toggleProject = (id: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCustomer = (id: string) => {
    setSelectedCustomerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!title.trim() || !brief.trim()) return;
    setSaving(true);
    try {
      const payload: CreateResearchTopicPayload = {
        title: title.trim(),
        brief: brief.trim(),
        scope: {
          mode: scopeMode,
          projectIds: scopeMode === 'selected' ? [...selectedProjectIds] : [],
          customerIds: scopeMode === 'selected' ? [...selectedCustomerIds] : [],
          includeGlobal,
        },
        webSearch: {
          enabled: webSearchEnabled,
          provider: webSearchEnabled && webSearchProvider ? webSearchProvider : undefined,
        },
        schedule: {
          frequency,
          hour,
          dayOfWeek: showDayOfWeek ? dayOfWeek : undefined,
          dayOfMonth: showDayOfMonth ? dayOfMonth : undefined,
          active: scheduleActive,
        },
        guardrails: {
          maxIterations,
          maxWebSearches,
          maxWebFetches,
          timeoutMs,
        },
      };
      const topic = await api.researchTopics.create(payload);
      onCreated(topic._id);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      <Dialog title={t('researchTopics.createTitle')} onClose={onCancel}>
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          <FormInput
            fieldClassName="w-full"
            label={t('researchTopics.titleLabel')}
            required
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('researchTopics.titlePlaceholder')}
            autoFocus
          />

          <FormTextarea
            fieldClassName="w-full"
            label={t('researchTopics.briefLabel')}
            required
            rows={4}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={t('researchTopics.briefPlaceholder')}
          />

          {/* Scope */}
          <div>
            <p className="text-xs font-medium text-gray-400 mb-2">{t('researchTopics.scopeLabel')}</p>
            <div className="flex gap-4 mb-2">
              <label className="flex items-center gap-1.5 text-sm text-gray-200 cursor-pointer">
                <input
                  type="radio"
                  name="scopeMode"
                  checked={scopeMode === 'all'}
                  onChange={() => setScopeMode('all')}
                  className={radioClass}
                />
                {t('researchTopics.scopeModeAll')}
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-200 cursor-pointer">
                <input
                  type="radio"
                  name="scopeMode"
                  checked={scopeMode === 'selected'}
                  onChange={() => setScopeMode('selected')}
                  className={radioClass}
                />
                {t('researchTopics.scopeModeSelected')}
              </label>
            </div>

            {scopeMode === 'selected' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
                <div>
                  <p className="text-xs text-gray-500 mb-1">{t('researchTopics.scopeProjectsLabel')}</p>
                  <div className="max-h-40 overflow-y-auto space-y-1 border border-gray-800 rounded-lg p-2">
                    {projects.length === 0 ? (
                      <p className="text-xs text-gray-500 px-2 py-1">{t('researchTopics.noProjects')}</p>
                    ) : (
                      projects.map((p) => (
                        <label
                          key={p._id}
                          className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer text-sm text-gray-200"
                        >
                          <input
                            type="checkbox"
                            checked={selectedProjectIds.has(p._id)}
                            onChange={() => toggleProject(p._id)}
                            className={checkboxClass}
                          />
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
                        <label
                          key={c._id}
                          className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer text-sm text-gray-200"
                        >
                          <input
                            type="checkbox"
                            checked={selectedCustomerIds.has(c._id)}
                            onChange={() => toggleCustomer(c._id)}
                            className={checkboxClass}
                          />
                          <span>{c.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
              <input
                type="checkbox"
                checked={includeGlobal}
                onChange={(e) => setIncludeGlobal(e.target.checked)}
                className={checkboxClass}
              />
              {t('researchTopics.scopeIncludeGlobal')}
            </label>
          </div>

          {/* Schedule */}
          <div className="border-t border-gray-800 pt-4">
            <p className="text-xs font-medium text-gray-400 mb-2">{t('researchTopics.scheduleLabel')}</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <FormSelect
                fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
                label={t('recurringTasks.frequency')}
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as ResearchFrequency)}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>{t(`recurringTasks.freq_${f}`)}</option>
                ))}
              </FormSelect>

              {showDayOfWeek && (
                <FormSelect
                  fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
                  label={t('recurringTasks.dayOfWeek')}
                  value={String(dayOfWeek)}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
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
                  value={String(dayOfMonth)}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}.</option>
                  ))}
                </FormSelect>
              )}

              <FormSelect
                fieldClassName="w-full sm:flex-1 sm:min-w-[9rem]"
                label={t('recurringTasks.hour')}
                value={String(hour)}
                onChange={(e) => setHour(Number(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                  <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
                ))}
              </FormSelect>
            </div>

            <label className="flex items-center gap-2 mt-3 text-sm text-gray-200">
              <Switch checked={scheduleActive} onChange={setScheduleActive} label={t('researchTopics.scheduleActive')} />
              {t('researchTopics.scheduleActive')}
            </label>
          </div>

          {/* Web search */}
          <div className="border-t border-gray-800 pt-4">
            <p className="text-xs font-medium text-gray-400 mb-2">{t('researchTopics.webSearchLabel')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <Switch checked={webSearchEnabled} onChange={setWebSearchEnabled} label={t('settings.webSearch.enabled')} />
              {t('settings.webSearch.enabled')}
            </label>
            {webSearchEnabled && (
              <FormSelect
                fieldClassName="w-full sm:w-64 mt-2"
                label={t('settings.webSearch.providerTitle')}
                value={webSearchProvider}
                onChange={(e) => setWebSearchProvider(e.target.value)}
              >
                <option value="">{t('researchTopics.webSearchProviderDefault')}</option>
                {WEB_SEARCH_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{t(PROVIDER_LABEL_KEY[p])}</option>
                ))}
              </FormSelect>
            )}
          </div>

          {/* Guardrails */}
          <details
            className="border-t border-gray-800 pt-4"
            open={guardrailsOpen}
            onToggle={(e) => setGuardrailsOpen(e.currentTarget.open)}
          >
            <summary className="text-xs font-medium text-gray-400 cursor-pointer select-none">
              {t('researchTopics.guardrailsLabel')}
            </summary>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <FormInput
                type="number"
                min={1}
                label={t('researchTopics.guardrailsMaxIterations')}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
              />
              <FormInput
                type="number"
                min={1}
                label={t('researchTopics.guardrailsMaxWebSearches')}
                value={maxWebSearches}
                onChange={(e) => setMaxWebSearches(Number(e.target.value))}
              />
              <FormInput
                type="number"
                min={1}
                label={t('researchTopics.guardrailsMaxWebFetches')}
                value={maxWebFetches}
                onChange={(e) => setMaxWebFetches(Number(e.target.value))}
              />
              <FormInput
                type="number"
                min={1000}
                step={1000}
                label={t('researchTopics.guardrailsTimeoutMs')}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
              />
            </div>
          </details>

          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" onClick={onCancel} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleCreate}
              disabled={saving || !title.trim() || !brief.trim()}
            >
              {saving ? t('common.creating') : t('researchTopics.createAction')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Portal>
  );
}
