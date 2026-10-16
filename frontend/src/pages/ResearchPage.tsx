import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type ResearchEntry } from '../api/client';
import { useFetch } from '../hooks/useFetch';
import { isActiveStatus, parseMoveTarget } from '../lib/research';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';
import ResearchStatusBadge from '../components/research-run/ResearchStatusBadge';
import NewResearchDialog from '../components/research-run/NewResearchDialog';

const POLL_MS = 5_000;

interface PageData {
  items: ResearchEntry[];
  positions: Record<string, number>;
}

async function loadPage(): Promise<PageData> {
  const [items, queue] = await Promise.all([api.research.listMine(), api.research.queue()]);
  return { items, positions: Object.fromEntries(queue.positions.map((p) => [p.id, p.position])) };
}

/** Name des vorgemerkten Ziels für den Hinweis im Dialog; Fehler → kein Hinweis. */
function useTargetName(hint: string | undefined): string | undefined {
  const [name, setName] = useState<string | undefined>();
  useEffect(() => {
    const target = parseMoveTarget(hint);
    if (!target) return;
    let alive = true;
    const load = target.kind === 'project' ? api.projects.get(target.id) : api.customers.get(target.id);
    load.then((x) => { if (alive) setName(x.name); }).catch(() => { /* Hinweis entfällt */ });
    return () => { alive = false; };
  }, [hint]);
  return name;
}

export default function ResearchPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, loading, error, refresh } = useFetch<PageData>(loadPage, { items: [], positions: {} });
  const showNew = params.get('new') === '1';
  const target = params.get('target') ?? undefined;
  const hint = parseMoveTarget(target) ? target : undefined;
  const targetName = useTargetName(hint);

  const anyActive = data.items.some((r) => r.status !== undefined && isActiveStatus(r.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, refresh]);

  const closeDialog = () => setParams({}, { replace: true });
  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t('researchRun.pageTitle')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('researchRun.pageDesc')}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link to="/research/topics" className="text-xs text-gray-500 hover:text-gray-300 self-center">
            {t('researchRun.oldTopics')}
          </Link>
          <Button variant="primary" size="sm" onClick={() => setParams({ new: '1' })}>
            {t('researchRun.new')}
          </Button>
        </div>
      </div>

      {loading && data.items.length === 0 ? (
        <LoadingText />
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : data.items.length === 0 ? (
        <EmptyState message={t('researchRun.empty')} />
      ) : (
        <div className="space-y-3">
          {data.items.map((r) => (
            <Link key={r._id} to={`/research/${r._id}`} className="block">
              <Card className="hover:border-gray-600 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold truncate min-w-0">{r.title}</h2>
                  {r.status && <ResearchStatusBadge status={r.status} position={data.positions[r._id]} />}
                </div>
                <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
                  {r.depth && <span>{t(`researchRun.depth.${r.depth}`)}</span>}
                  <span>{new Date(r.createdAt).toLocaleString(locale)}</span>
                  {r.error && <span className="text-red-400 truncate">{r.error}</span>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {showNew && (
        <NewResearchDialog
          moveTargetHint={hint}
          targetName={targetName}
          onClose={closeDialog}
          onStarted={(ids) => {
            if (ids.length === 1) { void navigate(`/research/${ids[0]}`); return; }
            closeDialog();
            refresh();
          }}
        />
      )}
    </div>
  );
}
