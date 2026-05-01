import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, Milestone } from '../api/client';
import TodoForm from '../components/TodoForm';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';

export default function TodoCreatePage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [milestoneId, setMilestoneId] = useState(searchParams.get('milestoneId') || '');
  const [milestones, setMilestones] = useState<Milestone[]>([]);

  const loadMilestones = () => { if (id) api.milestones.list(id).then(setMilestones); };
  useEffect(() => { loadMilestones(); }, [id]);

  return (
    <WorkflowPageShell backTo={`/projects/${id}`} backLabel={t('todoDetail.backToProject')} title={t('todoCreate.title')}>
      {id && (
        <TodoForm
          projectId={id}
          initialMilestoneId={milestoneId}
          milestones={milestones}
          showMilestoneSelect
          allowMilestoneCreate
          enableDictation
          onMilestoneCreated={(milestone) => { setMilestoneId(milestone._id); loadMilestones(); }}
          onCreated={() => navigate(`/projects/${id}`)}
          onCancel={() => navigate(`/projects/${id}`)}
        />
      )}
    </WorkflowPageShell>
  );
}
