import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Project } from '../../api/client';
import Badge from '../ui/Badge';

interface Props {
  project: Project;
  id: string;
}

export default function ProjectHeader({ project, id }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mb-6">
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; {t('common.allProjects')}
      </Link>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{project.name}</h1>
        <Badge color={project.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
          {project.active ? t('common.active') : t('common.inactive')}
        </Badge>
        <Link
          to={`/projects/${id}/settings`}
          className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-full transition-colors"
        >
          {t('nav.settings')}
        </Link>
      </div>
      {project.description && (
        <p className="mt-1 text-sm text-gray-500 truncate">{project.description}</p>
      )}
    </div>
  );
}
