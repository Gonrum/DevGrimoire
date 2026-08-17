import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { api, RecurringAction, RecurringFrequency, Project } from '../api/client';
import { errorMessage, optionOr } from '../lib/narrow';
import MarkdownEditor from '../components/MarkdownEditor';
import Button from '../components/ui/Button';
import { FormInput, FormSelect } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';

const FREQUENCIES: RecurringFrequency[] = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
const ACTIONS: RecurringAction[] = ['todo', 'chat'];
/**
 * Die in den `<select>`s angebotenen Werte. Vorher war `priority` ein blosser
 * `string` und wurde per `as any` ins DTO gedrückt; Aktion, Frequenz und
 * Session-Strategie wurden aus `e.target.value` heraus behauptet.
 */
const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
type TaskPriority = (typeof PRIORITIES)[number];
const SESSION_STRATEGIES = ['new', 'reuse'] as const;

export default function RecurringTaskCreatePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const isCustomerScope = location.pathname.startsWith('/customers/');
  const isGlobal = !id;
  const projectId = isCustomerScope ? undefined : id;
  const customerId = isCustomerScope ? id : undefined;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [tags, setTags] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('weekly');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [month, setMonth] = useState(1);
  const [hour, setHour] = useState(9);
  const [saving, setSaving] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(id || '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [action, setAction] = useState<RecurringAction>('todo');
  const [chatPrompt, setChatPrompt] = useState('');
  const [chatSystemPrompt, setChatSystemPrompt] = useState('');
  const [chatAllowedTools, setChatAllowedTools] = useState('');
  const [chatSessionStrategy, setChatSessionStrategy] = useState<(typeof SESSION_STRATEGIES)[number]>('new');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isGlobal) {
      // Ohne die Liste bleibt das Ziel-Projekt-Dropdown leer; ein Fehler darf
      // hier nicht stumm bleiben (vorher eine unbehandelte Rejection).
      api.projects.list()
        .then(setProjects)
        .catch((err: unknown) => setError(errorMessage(err, t('common.errorLoading', { error: '' }))));
    }
  }, [isGlobal, t]);

  const showDayOfWeek = frequency === 'weekly' || frequency === 'biweekly';
  const showDayOfMonth = frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly';
  const showMonth = frequency === 'yearly';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return;
    const targetProjectId = isCustomerScope
      ? undefined
      : isGlobal ? (selectedProjectId || undefined) : projectId;
    if (action === 'chat' && !targetProjectId && !customerId) {
      setError(t('recurringTasks.chatRequiresScope'));
      return;
    }
    if (action === 'chat' && !chatPrompt.trim()) {
      setError(t('recurringTasks.chatRequiresPrompt'));
      return;
    }
    setSaving(true);
    try {
      await api.recurringTasks.create({
        projectId: targetProjectId,
        customerId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        frequency,
        dayOfWeek: showDayOfWeek ? dayOfWeek : undefined,
        dayOfMonth: showDayOfMonth ? dayOfMonth : undefined,
        month: showMonth ? month : undefined,
        hour,
        action,
        chat: action === 'chat' ? {
          prompt: chatPrompt.trim(),
          systemPrompt: chatSystemPrompt.trim() || undefined,
          allowedTools: chatAllowedTools.split(',').map((t) => t.trim()).filter(Boolean),
          sessionStrategy: chatSessionStrategy,
        } : undefined,
      });
      if (isCustomerScope) {
        void navigate(`/customers/${id}?tab=workflows`);
      } else if (isGlobal) {
        void navigate('/recurring-tasks');
      } else {
        void navigate(`/projects/${id}?tab=recurring-tasks`);
      }
    } catch (err) {
      setError(errorMessage(err, t('common.errorSaving')));
    } finally {
      setSaving(false);
    }
  };

  const backLink = isCustomerScope
    ? `/customers/${id}?tab=workflows`
    : isGlobal ? '/recurring-tasks' : `/projects/${id}?tab=recurring-tasks`;
  const backLabel = isCustomerScope
    ? t('recurringTasks.backToCustomer')
    : isGlobal ? t('recurringTasks.globalTitle') : t('recurringTasks.backToProject');

  return (
    <WorkflowPageShell backTo={backLink} backLabel={backLabel} title={t('recurringTasks.createTitle')}>
      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
        {error && (
          <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-200">{error}</div>
        )}

        <FormInput fieldClassName="w-full" label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.title')} autoFocus />

        <FormSelect
          fieldClassName="w-full"
          label={t('recurringTasks.actionLabel')}
          value={action}
          onChange={(e) => setAction(optionOr(e.target.value, ACTIONS, 'todo'))}
        >
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{t(`recurringTasks.action_${a}`)}</option>
          ))}
        </FormSelect>
        <p className="-mt-2 text-xs text-gray-500">{t(`recurringTasks.actionHint_${action}`)}</p>

        {isGlobal && !isCustomerScope && (
          <FormSelect
            fieldClassName="w-full"
            label={t('recurringTasks.targetProject')}
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            <option value="">{t('recurringTasks.systemWideOption')}</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </FormSelect>
        )}
        {isGlobal && !isCustomerScope && (
          <p className="-mt-2 text-xs text-gray-600">{t('recurringTasks.systemWideHint')}</p>
        )}

        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
          <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder={t('recurringTasks.descriptionPlaceholder')} />
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <FormSelect fieldClassName="w-full sm:w-44 shrink-0" label={t('common.priority')} value={priority} onChange={(e) => setPriority(optionOr(e.target.value, PRIORITIES, 'medium'))}>
            <option value="low">{t('todoPriority.low')}</option>
            <option value="medium">{t('todoPriority.medium')}</option>
            <option value="high">{t('todoPriority.high')}</option>
            <option value="critical">{t('todoPriority.critical')}</option>
          </FormSelect>
          <FormInput
            fieldClassName="flex-1 min-w-0 w-full"
            label={t('common.tags')}
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('todoCreate.tagsPlaceholder')}
          />
        </div>

        <div className="border-t border-gray-800 pt-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">{t('recurringTasks.schedule')}</h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <FormSelect fieldClassName="w-full sm:flex-1" label={t('recurringTasks.frequency')} value={frequency} onChange={(e) => setFrequency(optionOr(e.target.value, FREQUENCIES, 'weekly'))}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>{t(`recurringTasks.freq_${f}`)}</option>
              ))}
            </FormSelect>

            {showDayOfWeek && (
              <FormSelect fieldClassName="w-full sm:flex-1" label={t('recurringTasks.dayOfWeek')} value={String(dayOfWeek)} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>{t(`recurringTasks.day_${d}`)}</option>
                ))}
              </FormSelect>
            )}

            {showDayOfMonth && (
              <FormSelect fieldClassName="w-full sm:flex-1" label={t('recurringTasks.dayOfMonth')} value={String(dayOfMonth)} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}.</option>
                ))}
              </FormSelect>
            )}

            {showMonth && (
              <FormSelect fieldClassName="w-full sm:flex-1" label={t('recurringTasks.month')} value={String(month)} onChange={(e) => setMonth(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{t(`recurringTasks.month_${m}`)}</option>
                ))}
              </FormSelect>
            )}

            <FormSelect fieldClassName="w-full sm:flex-1" label={t('recurringTasks.hour')} value={String(hour)} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </FormSelect>
          </div>
        </div>

        {action === 'chat' && (
          <div className="border-t border-gray-800 pt-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-300">{t('recurringTasks.chatSection')}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('recurringTasks.chatPrompt')}<span className="text-red-400 ml-1">*</span></label>
                <textarea
                  value={chatPrompt}
                  onChange={(e) => setChatPrompt(e.target.value)}
                  rows={4}
                  required={action === 'chat'}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
                  placeholder={t('recurringTasks.chatPromptPlaceholder')}
                />
                <p className="mt-1 text-xs text-gray-600">{t('recurringTasks.chatPromptHint')}</p>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('recurringTasks.chatSystemPrompt')}</label>
                <textarea
                  value={chatSystemPrompt}
                  onChange={(e) => setChatSystemPrompt(e.target.value)}
                  rows={2}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
                  placeholder={t('recurringTasks.chatSystemPromptPlaceholder')}
                />
              </div>

              <FormInput
                fieldClassName="w-full"
                label={t('recurringTasks.chatAllowedTools')}
                type="text"
                value={chatAllowedTools}
                onChange={(e) => setChatAllowedTools(e.target.value)}
                placeholder="todo_list, knowledge_search, rag_search"
              />
              <p className="-mt-2 text-xs text-gray-600">{t('recurringTasks.chatAllowedToolsHint')}</p>

              <FormSelect
                fieldClassName="w-full sm:w-64"
                label={t('recurringTasks.chatSessionStrategy')}
                value={chatSessionStrategy}
                onChange={(e) => setChatSessionStrategy(optionOr(e.target.value, SESSION_STRATEGIES, 'new'))}
              >
                <option value="new">{t('recurringTasks.chatSessionNew')}</option>
                <option value="reuse">{t('recurringTasks.chatSessionReuse')}</option>
              </FormSelect>
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !title.trim()}>
            {saving ? t('common.creating') : t('common.create')}
          </Button>
          <Button type="button" size="lg" onClick={() => { void navigate(backLink); }}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </WorkflowPageShell>
  );
}
