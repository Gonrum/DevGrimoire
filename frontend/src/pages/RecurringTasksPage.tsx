import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, RecurringTask } from '../api/client';
import RecurringTaskList from '../components/RecurringTaskList';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';

export default function RecurringTasksPage() {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [tasks, setTasks] = useState<RecurringTask[]>([]);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'system' | 'project'>('all');

  /*
   * Vorher hing hier ein `.then(...).finally(...)` **ohne** `.catch`: eine
   * abgelehnte Liste liess `loading` auf false laufen und zeigte eine leere
   * Seite ohne jede Meldung — für den Nutzer nicht von "es gibt keine Tasks"
   * unterscheidbar. Fehler geht jetzt in den Toast.
   */
  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const [rts, projects] = await Promise.all([
          api.recurringTasks.list(),
          api.projects.list(),
        ]);
        if (cancelled) return;
        setTasks(rts);
        const names: Record<string, string> = {};
        for (const project of projects) names[project._id] = project.name;
        setProjectNames(names);
      } catch (err) {
        if (!cancelled) showError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [showError]);

  if (loading) return <LoadingText />;

  const filtered = filter === 'all' ? tasks
    : filter === 'system' ? tasks.filter((t) => !t.projectId)
    : tasks.filter((t) => !!t.projectId);

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">{t('recurringTasks.globalTitle')}</h1>

      <div className="flex gap-2 mb-4">
        {(['all', 'system', 'project'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              filter === f
                ? 'bg-violet-900/50 text-cyan-300 border border-violet-700'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200'
            }`}
          >
            {t(`recurringTasks.filter_${f}`)}
            <span className="ml-1.5 text-xs opacity-70">
              {f === 'all' ? tasks.length : f === 'system' ? tasks.filter((t) => !t.projectId).length : tasks.filter((t) => !!t.projectId).length}
            </span>
          </button>
        ))}
      </div>

      <RecurringTaskList entries={filtered} projectNames={projectNames} />
    </div>
  );
}
