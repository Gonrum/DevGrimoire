import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Project, Environment } from '../../../api/client';
import Badge from '../../ui/Badge';
import GitRepoWidget from '../../GitRepoWidget';
import ProjectCustomerLinks from '../../ProjectCustomerLinks';

const TECH_LIMIT = 8;

interface Props {
  project: Project;
  id: string;
  environments: Environment[];
  onNavigateToCommits: () => void;
}

export default function ProjectProfileCard({ project, id, environments, onNavigateToCommits }: Props) {
  const { t, i18n } = useTranslation();
  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const [stackExpanded, setStackExpanded] = useState(false);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const stack = stackExpanded ? project.techStack : project.techStack.slice(0, TECH_LIMIT);
  const hiddenStack = project.techStack.length - stack.length;
  const components = project.components ?? [];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">{t('projectDetail.overview.profile')}</h3>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        {project.path && <span>{t('projects.path')}: {project.path}</span>}
        {project.repository && <span>{t('projects.repo')}: {project.repository}</span>}
        <span>{t('common.created')}: {new Date(project.createdAt).toLocaleDateString(dateFmtLocale)}</span>
        <span>{t('common.updated')}: {new Date(project.updatedAt).toLocaleDateString(dateFmtLocale)}</span>
      </div>

      {project.techStack.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {stack.map((tech) => (
            <Badge key={tech} color="bg-violet-900/40 text-cyan-300">{tech}</Badge>
          ))}
          {hiddenStack > 0 && (
            <button type="button" onClick={() => setStackExpanded(true)} className="text-xs text-cyan-400 hover:text-cyan-300 px-1">
              {t('projectDetail.overview.showAll', { count: hiddenStack })}
            </button>
          )}
          {stackExpanded && project.techStack.length > TECH_LIMIT && (
            <button type="button" onClick={() => setStackExpanded(false)} className="text-xs text-gray-500 hover:text-gray-300 px-1">
              {t('projectDetail.overview.showLess')}
            </button>
          )}
        </div>
      )}

      {components.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setComponentsOpen((v) => !v)}
            aria-expanded={componentsOpen}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300"
          >
            {componentsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('projectDetail.overview.components', { count: components.length })}
          </button>
          {componentsOpen && (
            <div className="flex flex-wrap gap-2 mt-2">
              {components.map((c) => (
                <Badge key={c.name} color="bg-purple-900/40 text-purple-300">
                  {c.name} <span className="text-purple-400 font-mono">v{c.version}</span>
                  {c.path && <span className="text-purple-500 ml-1">({c.path})</span>}
                </Badge>
              ))}
            </div>
          )}
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
