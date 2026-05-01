import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MilestoneForm from '../components/MilestoneForm';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';

export default function MilestoneCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <WorkflowPageShell backTo={`/projects/${id}`} backLabel={t('milestoneCreate.backToProject')} title={t('milestoneCreate.title')}>
      {id && (
        <MilestoneForm
          projectId={id}
          submitLabel={t('common.create')}
          savingLabel={t('common.creating')}
          onSaved={() => navigate(`/projects/${id}?tab=milestones`)}
          onCancel={() => navigate(`/projects/${id}`)}
        />
      )}
    </WorkflowPageShell>
  );
}
