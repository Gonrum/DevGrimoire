import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Project } from '../api/client';
import LogList from '../components/LogList';
import { LoadingText } from '../components/ui/LoadingSpinner';

/**
 * T-338: cross-project log viewer for admins. Loads the project list
 * (for the multi-select filter + per-row labels) once, then defers all
 * filtering + fetching to LogList in its global mode.
 */
export default function GlobalLogsView() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.projects.list()
      .then((list) => {
        if (cancelled) return;
        // Surface active projects first, sorted by name — matches the rest
        // of the app's project-picker UX.
        const sorted = [...list].sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setProjects(sorted);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire mb-1">{t('globalLogs.title')}</h1>
        <p className="text-sm text-gray-500">{t('globalLogs.subtitle')}</p>
      </div>
      {loading ? <LoadingText /> : <LogList projects={projects} />}
    </div>
  );
}
