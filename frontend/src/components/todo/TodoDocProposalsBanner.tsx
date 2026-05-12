import { useCallback, useEffect, useState } from 'react';
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
  const [proposals, setProposals] = useState<DocUpdateProposal[]>([]);

  const load = useCallback(() => {
    api.docUpdateProposals
      .list({ sourceType: 'todo', sourceId: todoId, status: 'open', limit: 20 })
      .then(setProposals)
      .catch(() => setProposals([]));
  }, [todoId]);

  useEffect(() => {
    if (todoStatus !== 'review' && todoStatus !== 'done') {
      setProposals([]);
      return;
    }
    load();
  }, [todoId, todoStatus, load]);

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
