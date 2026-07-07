import { useTranslation } from 'react-i18next';
import { Project, Todo, Milestone, Activity, Session, Environment } from '../../../api/client';
import type { Tab } from '../tabs';
import ActivityList from '../../ActivityList';
import OverviewStatRow, { StatItem } from './OverviewStatRow';
import OverviewTodos from './OverviewTodos';
import OverviewMilestones from './OverviewMilestones';
import ProjectProfileCard from './ProjectProfileCard';

interface Props {
  project: Project;
  id: string;
  todos: Todo[];
  milestones: Milestone[];
  activities: Activity[];
  sessions: Session[];
  environments: Environment[];
  openOracleCount: number;
  openDocProposalsCount: number;
  onNavigate: (tab: Tab) => void;
}

export default function ProjectOverview({
  project, id, todos, milestones, activities, sessions, environments,
  openOracleCount, openDocProposalsCount, onNavigate,
}: Props) {
  const { t, i18n } = useTranslation();
  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const openTodos = todos.filter((td) => td.status !== 'done' && !td.archived).length;
  const activeMilestones = milestones.filter((m) => m.status !== 'done' && !m.archived).length;
  const lastSession = sessions[0]?.createdAt
    ? new Date(sessions[0].createdAt).toLocaleDateString(dateFmtLocale)
    : t('projectDetail.overview.lastSessionNever');

  const stats: StatItem[] = [
    { key: 'todos', label: t('projectDetail.tab.todos'), value: openTodos, tab: 'todos' },
    { key: 'milestones', label: t('projectDetail.tab.milestones'), value: activeMilestones, tab: 'milestones' },
    { key: 'oracle', label: t('projectDetail.tab.oracle'), value: openOracleCount, tab: 'oracle' },
    { key: 'docs', label: t('projectDetail.tab.docsHealth'), value: openDocProposalsCount, tab: 'docs-health' },
    { key: 'sessions', label: t('projectDetail.tab.sessions'), value: lastSession, tab: 'sessions' },
  ];

  return (
    <div className="space-y-6">
      <OverviewStatRow stats={stats} onNavigate={onNavigate} />

      <div className="grid md:grid-cols-2 gap-4">
        <OverviewTodos todos={todos} projectId={id} onViewAll={() => onNavigate('todos')} />
        <OverviewMilestones milestones={milestones} todos={todos} onViewAll={() => onNavigate('milestones')} />
      </div>

      <ProjectProfileCard
        project={project}
        id={id}
        environments={environments}
        onNavigateToCommits={() => onNavigate('commits')}
      />

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">{t('projectDetail.tab.activity')}</h3>
          <button type="button" onClick={() => onNavigate('activity')} className="text-xs text-cyan-400 hover:text-cyan-300">
            {t('projectDetail.overview.viewAll')}
          </button>
        </div>
        <ActivityList activities={activities.slice(0, 8)} />
      </div>
    </div>
  );
}
