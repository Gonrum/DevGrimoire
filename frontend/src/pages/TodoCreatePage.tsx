import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, Milestone } from '../api/client';
import TodoForm from '../components/TodoForm';

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
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('todoDetail.backToProject')}</Link>

      <h1 className="text-xl font-bold mb-6">{t('todoCreate.title')}</h1>

      {id && (
        <TodoForm
          projectId={id}
          initialMilestoneId={milestoneId}
          milestones={milestones}
          showMilestoneSelect
          allowMilestoneCreate
          enableDictation
          className="max-w-3xl mx-auto"
          onMilestoneCreated={(milestone) => { setMilestoneId(milestone._id); loadMilestones(); }}
          onCreated={() => navigate(`/projects/${id}`)}
          onCancel={() => navigate(`/projects/${id}`)}
        />
      )}
    </div>
  );
}
