import { useTranslation } from 'react-i18next';
import { Project, Todo, Milestone, Activity, Environment } from '../../../api/client';
import type { Tab } from '../tabs';
import ActivityList from '../../ActivityList';
import OverviewOpen from './OverviewOpen';
import ProjectProfileCard from './ProjectProfileCard';

const ACTIVITY_LIMIT = 5;

interface Props {
  project: Project;
  id: string;
  todos: Todo[];
  milestones: Milestone[];
  activities: Activity[];
  environments: Environment[];
  openOracleCount: number;
  openDocProposalsCount: number;
  onNavigate: (tab: Tab) => void;
}

export default function ProjectOverview({
  project, id, todos, milestones, activities, environments,
  openOracleCount, openDocProposalsCount, onNavigate,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <OverviewOpen
        projectId={id}
        todos={todos}
        milestones={milestones}
        openOracleCount={openOracleCount}
        openDocProposalsCount={openDocProposalsCount}
        onNavigate={onNavigate}
      />

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
        <ActivityList activities={activities.slice(0, ACTIVITY_LIMIT)} />
      </div>
    </div>
  );
}
