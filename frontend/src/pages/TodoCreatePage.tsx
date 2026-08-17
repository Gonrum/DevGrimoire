import { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { api, Milestone } from '../api/client';
import TodoForm from '../components/TodoForm';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';

export default function TodoCreatePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const isCustomerScope = location.pathname.startsWith('/customers/');
  const basePath = isCustomerScope ? `/customers/${id}` : `/projects/${id}`;
  const backLabelKey = isCustomerScope ? 'todoDetail.backToCustomer' : 'todoDetail.backToProject';
  const { t } = useTranslation();
  const { showError } = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [milestoneId, setMilestoneId] = useState(searchParams.get('milestoneId') || '');
  const [milestones, setMilestones] = useState<Milestone[]>([]);

  /*
   * `.catch` war vorher nicht da: schlug die Milestone-Liste fehl, blieb das
   * Auswahlfeld einfach leer — der Nutzer hätte "dieses Projekt hat keine
   * Milestones" gelesen, wo tatsächlich der Request gescheitert war.
   */
  const loadMilestones = useCallback(() => {
    if (!id || isCustomerScope) return;
    api.milestones
      .list(id)
      .then(setMilestones)
      .catch((err: unknown) => showError(errorMessage(err)));
  }, [id, isCustomerScope, showError]);
  useEffect(() => { loadMilestones(); }, [loadMilestones]);

  return (
    <WorkflowPageShell backTo={basePath} backLabel={t(backLabelKey)} title={t('todoCreate.title')}>
      {id && (
        <TodoForm
          projectId={isCustomerScope ? undefined : id}
          customerId={isCustomerScope ? id : undefined}
          initialMilestoneId={milestoneId}
          milestones={milestones}
          showMilestoneSelect={!isCustomerScope}
          allowMilestoneCreate={!isCustomerScope}
          enableDictation
          onMilestoneCreated={(milestone) => { setMilestoneId(milestone._id); loadMilestones(); }}
          onCreated={() => { void navigate(basePath); }}
          onCancel={() => { void navigate(basePath); }}
        />
      )}
    </WorkflowPageShell>
  );
}
