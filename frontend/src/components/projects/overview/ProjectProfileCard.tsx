import { useTranslation } from 'react-i18next';
import { Project, Environment } from '../../../api/client';
import Badge from '../../ui/Badge';
import Markdown from '../../Markdown';
import GitRepoWidget from '../../GitRepoWidget';
import ProjectCustomerLinks from '../../ProjectCustomerLinks';

interface Props {
  project: Project;
  id: string;
  environments: Environment[];
  onNavigateToCommits: () => void;
}

export default function ProjectProfileCard({ project, id, environments, onNavigateToCommits }: Props) {
  const { t, i18n } = useTranslation();
  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">{t('projectDetail.overview.profile')}</h3>

      {project.description && (
        <div className="text-gray-400 text-sm">
          <Markdown>{project.description}</Markdown>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        {project.path && <span>{t('projects.path')}: {project.path}</span>}
        {project.repository && <span>{t('projects.repo')}: {project.repository}</span>}
        <span>{t('common.created')}: {new Date(project.createdAt).toLocaleDateString(dateFmtLocale)}</span>
        <span>{t('common.updated')}: {new Date(project.updatedAt).toLocaleDateString(dateFmtLocale)}</span>
      </div>

      {project.techStack.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.techStack.map((tech) => (
            <Badge key={tech} color="bg-violet-900/40 text-cyan-300">{tech}</Badge>
          ))}
        </div>
      )}

      {project.components && project.components.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {project.components.map((c) => (
            <Badge key={c.name} color="bg-purple-900/40 text-purple-300">
              {c.name} <span className="text-purple-400 font-mono">v{c.version}</span>
              {c.path && <span className="text-purple-500 ml-1">({c.path})</span>}
            </Badge>
          ))}
        </div>
      )}

      {project.gitRepositories && project.gitRepositories.length > 0 && (
        <GitRepoWidget
          projectId={id}
          gitRepositories={project.gitRepositories}
          onNavigateToCommits={onNavigateToCommits}
        />
      )}

      <ProjectCustomerLinks projectId={id} environments={environments} />
    </div>
  );
}
