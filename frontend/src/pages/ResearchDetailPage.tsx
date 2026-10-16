import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type ResearchEntry, type ResearchStepItem } from '../api/client';
import { errorMessage } from '../lib/narrow';
import { allowedActions, isActiveStatus, type ResearchAction } from '../lib/research';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';
import ResearchStatusBadge from '../components/research-run/ResearchStatusBadge';
import ResearchReport from '../components/research-run/ResearchReport';
import ResearchSteps from '../components/research-run/ResearchSteps';
import ResearchLiveLanes from '../components/research-run/ResearchLiveLanes';
import DeepenDialog from '../components/research-run/DeepenDialog';
import MoveResearchDialog from '../components/research-run/MoveResearchDialog';
import { useResearchLive } from '../components/research-run/useResearchLive';

const POLL_MS = 4_000;
type SimpleAction = Extract<ResearchAction, 'cancel' | 'pause' | 'resume' | 'retry'>;
const SIMPLE: SimpleAction[] = ['cancel', 'pause', 'resume', 'retry'];

export default function ResearchDetailPage() {
  const { id = '' } = useParams();
  return <ResearchDetail key={id} id={id} />;
}

function ResearchDetail({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [doc, setDoc] = useState<ResearchEntry | null>(null);
  const [steps, setSteps] = useState<ResearchStepItem[]>([]);
  const [position, setPosition] = useState<number | undefined>();
  const [missing, setMissing] = useState(false);
  const [dialog, setDialog] = useState<'deepen' | 'move' | null>(null);

  const fetchAll = useCallback(async () => {
    const [d, s, q] = await Promise.all([api.research.get(id), api.research.steps(id), api.research.queue()]);
    return { d, steps: s.steps, position: q.positions.find((p) => p.id === id)?.position };
  }, [id]);

  const reload = useCallback(async () => {
    try {
      const r = await fetchAll();
      setDoc(r.d);
      setSteps(r.steps);
      setPosition(r.position);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
    }
  }, [fetchAll]);

  useEffect(() => {
    let alive = true;
    fetchAll().then((r) => {
      if (!alive) return;
      setDoc(r.d);
      setSteps(r.steps);
      setPosition(r.position);
    }).catch((err: unknown) => { if (alive && err instanceof ApiError && err.status === 404) setMissing(true); });
    return () => { alive = false; };
  }, [fetchAll]);

  const active = doc?.status !== undefined && isActiveStatus(doc.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void reload(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);

  const live = useResearchLive(id, active, () => { void reload(); });

  /** Alle Aktionen über einen Weg: 409 aus einem Wettlauf wird Meldung, danach frischer Stand. */
  const run = async (fn: () => Promise<void>, success?: string) => {
    let ok = false;
    try {
      await fn();
      ok = true;
      if (success) showSuccess(success);
    } catch (err) {
      showError(errorMessage(err, t('researchRun.errors.action')));
    }
    await reload();
    return ok;
  };

  if (missing) {
    return (
      <div className="max-w-5xl mx-auto">
        <Link to="/research" className="text-sm text-gray-500 hover:text-gray-300">{t('researchRun.detail.back')}</Link>
        <p className="mt-4 text-sm text-gray-400">{t('researchRun.detail.notFound')}</p>
      </div>
    );
  }
  if (!doc) return <LoadingText />;

  const status = doc.status ?? 'done';
  const tasks = doc.tasks ?? [];
  const sourceList = doc.sourceList ?? [];
  const partial = tasks.some((x) => x.status === 'done') || sourceList.some((s) => s.relevant);
  const actions = allowedActions({ status, hasReport: doc.content.length > 0, partial });
  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const backTo = doc.projectId ? `/projects/${doc.projectId}?tab=research` : doc.customerId ? `/customers/${doc.customerId}?tab=research` : '/research';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <Link to={backTo} className="text-sm text-gray-500 hover:text-gray-300 inline-block">{t('researchRun.detail.back')}</Link>

      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold min-w-0 break-words">{doc.title}</h1>
          <ResearchStatusBadge status={status} position={position} />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
          {doc.depth && <span>{t(`researchRun.depth.${doc.depth}`)}</span>}
          <span>
            {doc.projectId ? t('researchRun.detail.assignedProject') : doc.customerId ? t('researchRun.detail.assignedCustomer') : t('researchRun.detail.personal')}
          </span>
          {doc.totalMs ? <span>{t('researchRun.detail.duration')}: {Math.round(doc.totalMs / 1000)} s</span> : null}
          {doc.model && doc.model.length > 0 && <span>{t('researchRun.detail.models')}: {doc.model.join(', ')}</span>}
          <span>{new Date(doc.createdAt).toLocaleString(locale)}</span>
        </div>
        {doc.focus && <p className="text-sm text-gray-400">{t('researchRun.detail.focus')}: {doc.focus}</p>}
        {doc.error && <p className="text-sm text-red-400">{doc.error}</p>}
      </header>

      <div className="flex flex-wrap gap-2">
        {SIMPLE.filter((a) => actions.includes(a)).map((a) => (
          <Button key={a} size="sm" variant={a === 'cancel' ? 'danger' : 'secondary'} onClick={() => { void run(() => api.research[a](id)); }}>
            {t(`researchRun.actions.${a}`)}
          </Button>
        ))}
        {actions.includes('deepen') && (
          <Button size="sm" variant="accent" onClick={() => setDialog('deepen')}>{t('researchRun.actions.deepen')}</Button>
        )}
        {actions.includes('move') && (
          <Button size="sm" variant="primary" onClick={() => setDialog('move')}>{t('researchRun.actions.move')}</Button>
        )}
        <ConfirmButton
          size="sm"
          label={t('researchRun.actions.delete')}
          confirmLabel={t('researchRun.actions.confirmDelete')}
          onConfirm={async () => {
            try {
              await api.research.delete(id);
              void navigate(backTo);
            } catch (err) {
              showError(errorMessage(err, t('common.errorDeleting')));
            }
          }}
        />
      </div>

      {active && <ResearchLiveLanes live={live} tasks={tasks} />}

      <Card>
        <h2 className="text-sm font-semibold mb-3">{t('researchRun.detail.report')}</h2>
        <ResearchReport content={doc.content} sourceList={sourceList} />
      </Card>

      {(doc.followUps?.length ?? 0) > 0 && (
        <Card>
          <h2 className="text-sm font-semibold mb-2">{t('researchRun.detail.followUps')}</h2>
          <ul className="text-sm text-gray-400 list-disc pl-5">
            {doc.followUps?.map((f, i) => <li key={`${f.at}-${i}`}>{f.question}</li>)}
          </ul>
        </Card>
      )}

      {(doc.relatedKnowledge?.length ?? 0) > 0 && (
        <Card>
          <h2 className="text-sm font-semibold mb-2">{t('researchRun.detail.related')}</h2>
          <ul className="text-sm text-gray-400 list-disc pl-5">
            {doc.relatedKnowledge?.map((k) => <li key={k.id}>{k.title}</li>)}
          </ul>
        </Card>
      )}

      {tasks.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold mb-2">{t('researchRun.detail.tasks')}</h2>
          <ul className="space-y-2 text-sm">
            {tasks.map((x) => (
              <li key={x.n}>
                <span className="text-gray-500 mr-2">t{x.n} · {t(`researchRun.status.${x.status === 'done' ? 'done' : x.status === 'failed' ? 'failed' : x.status === 'running' ? 'running' : 'queued'}`)}</span>
                <span className="text-gray-300">{x.question}</span>
                {x.summary && <p className="text-xs text-gray-500 mt-0.5">{x.summary}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold mb-2">{t('researchRun.detail.steps')}</h2>
        <ResearchSteps steps={steps} />
      </Card>

      {dialog === 'deepen' && (
        <DeepenDialog
          onClose={() => setDialog(null)}
          onSubmit={(question) => run(() => api.research.deepen(id, question)).then((ok) => { if (ok) setDialog(null); })}
        />
      )}
      {dialog === 'move' && (
        <MoveResearchDialog
          hint={doc.moveTargetHint}
          onClose={() => setDialog(null)}
          onSubmit={(target) => run(() => api.research.move(id, target), t('researchRun.move.moved')).then((ok) => { if (ok) setDialog(null); })}
        />
      )}
    </div>
  );
}
