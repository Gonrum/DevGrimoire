import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MilestoneForm from '../components/MilestoneForm';

export default function MilestoneCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('milestoneCreate.backToProject')}</Link>

      <h1 className="text-xl font-bold mb-6">{t('milestoneCreate.title')}</h1>

      {id && (
        <MilestoneForm
          projectId={id}
          submitLabel={t('common.create')}
          savingLabel={t('common.creating')}
          className="max-w-3xl mx-auto"
          onSaved={() => navigate(`/projects/${id}?tab=milestones`)}
          onCancel={() => navigate(`/projects/${id}`)}
        />
      )}
    </div>
  );
}
