import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, DocUpdateProposal } from '../../api/client';

interface Props {
  todoId: string;
  todoStatus: string;
  basePath: string;
}

export default function TodoDocProposalsBanner({ todoId, todoStatus, basePath }: Props) {
  const { t } = useTranslation();
  // Zusammen mit der `todoId` gespeichert: eine verspätete Antwort zum vorigen
  // Todo darf die Liste des aktuellen nicht überschreiben, und beim Wechsel
  // sollen nicht kurz die Vorschläge des Vorgängers stehen.
  const [loaded, setLoaded] = useState<{ todoId: string; proposals: DocUpdateProposal[] } | null>(null);

  // Vorschläge entstehen erst in Review/Done. Das frühere "leeren" im Effect war
  // abgeleiteter Zustand — der Status entscheidet direkt im Render.
  const relevant = todoStatus === 'review' || todoStatus === 'done';

  useEffect(() => {
    if (todoStatus !== 'review' && todoStatus !== 'done') return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.docUpdateProposals.list({
          sourceType: 'todo',
          sourceId: todoId,
          status: 'open',
          limit: 20,
        });
        if (!cancelled) setLoaded({ todoId, proposals: list });
      } catch {
        if (!cancelled) setLoaded({ todoId, proposals: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [todoId, todoStatus]);

  const proposals = relevant && loaded?.todoId === todoId ? loaded.proposals : [];

  if (proposals.length === 0) return null;

  return (
    <div className="bg-amber-900/15 border border-amber-800/40 rounded p-3 mb-5">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-sm font-medium text-amber-300">
          {t('docsHealth.banner.title', { count: proposals.length })}
        </span>
        <Link
          to={`${basePath.replace(/\/todos\/.*$/, '')}?tab=docs-health`}
          className="text-xs text-cyan-400 hover:underline ml-auto"
        >
          {t('docsHealth.banner.openSection')}
        </Link>
      </div>
      <ul className="space-y-1 text-xs text-gray-300">
        {proposals.slice(0, 5).map((p) => (
          <li key={p._id} className="flex items-start gap-2">
            <span className="text-amber-500/80">•</span>
            <span className="flex-1">
              <span className="text-gray-500 mr-1">[{p.target.type}]</span>
              {p.target.path ? <code className="text-gray-300">{p.target.path}</code> : p.target.title}
              <span className="text-gray-600"> — {p.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
