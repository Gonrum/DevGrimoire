import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  DocProposalChangeMode,
  DocProposalSourceType,
  DocProposalStatus,
  DocProposalTargetType,
  DocUpdateProposal,
} from '../api/client';
import { useToast } from './Toast';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

interface Props {
  projectId: string;
  basePath: string;
}

const STATUS_COLORS: Record<DocProposalStatus, string> = {
  open: 'bg-amber-900/40 text-amber-300',
  accepted: 'bg-green-900/40 text-green-300',
  edited: 'bg-cyan-900/40 text-cyan-300',
  converted_to_todo: 'bg-purple-900/40 text-purple-300',
  dismissed: 'bg-gray-800 text-gray-400',
  superseded: 'bg-gray-800 text-gray-500',
};

const MODE_LABELS: Record<DocProposalChangeMode, string> = {
  patch: 'patch',
  instructions: 'instructions',
  new_section: 'new section',
  review_only: 'review only',
};

function ProposalCard({
  proposal,
  basePath,
  busy,
  onUpdateStatus,
  onConvertToTodo,
  t,
}: {
  proposal: DocUpdateProposal;
  basePath: string;
  busy: boolean;
  onUpdateStatus: (status: DocProposalStatus) => void;
  onConvertToTodo: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const isOpen = proposal.status === 'open';
  const convertedTodoId = proposal.metadata?.todoId;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={STATUS_COLORS[proposal.status]} rounded="full">
          {t(`docsHealth.status.${proposal.status}`)}
        </Badge>
        <span className="text-xs text-gray-500 uppercase tracking-wide">
          {proposal.target.type} · {MODE_LABELS[proposal.suggestedChange.mode]}
        </span>
        <span className="text-xs text-gray-600 ml-auto">
          {t('docsHealth.confidence')}: <span className="text-gray-300">{proposal.confidence}/10</span>
        </span>
      </div>

      <div>
        <div className="text-sm text-gray-200 font-medium">
          {proposal.target.path ? <code className="bg-gray-950 px-1 py-0.5 rounded">{proposal.target.path}</code> : proposal.target.title}
        </div>
        <div className="text-xs text-gray-500">
          {t('docsHealth.from')} {proposal.source.type} ·{' '}
          {proposal.source.type === 'todo' && proposal.source.id ? (
            <Link to={`${basePath}/todos/${proposal.source.id}`} className="text-cyan-400 hover:underline">
              {proposal.source.title || proposal.source.id}
            </Link>
          ) : (
            <span className="text-gray-400">{proposal.source.title || proposal.source.id}</span>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400">{proposal.reason}</p>

      <div className="text-xs">
        <div className="text-gray-500 mb-0.5">{t('docsHealth.suggested')}</div>
        <pre className="text-gray-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2">
          {proposal.suggestedChange.summary}
        </pre>
        {proposal.suggestedChange.instructions && (
          <details className="mt-1">
            <summary className="text-gray-500 cursor-pointer select-none">{t('docsHealth.instructions')}</summary>
            <pre className="mt-1 text-gray-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2">
              {proposal.suggestedChange.instructions}
            </pre>
          </details>
        )}
      </div>

      {proposal.status === 'converted_to_todo' && convertedTodoId && (
        <div className="text-xs text-gray-500">
          {t('docsHealth.convertedTo')}{' '}
          <Link to={`${basePath}/todos/${convertedTodoId}`} className="text-cyan-400 hover:underline">
            {t('docsHealth.openTodo')}
          </Link>
        </div>
      )}

      {isOpen && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => onUpdateStatus('accepted')}>
            {t('docsHealth.accept')}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onConvertToTodo}>
            {t('docsHealth.convertToTodo')}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onUpdateStatus('dismissed')}>
            {t('docsHealth.dismiss')}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function DocsHealthList({ projectId, basePath }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [proposals, setProposals] = useState<DocUpdateProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<DocProposalStatus | 'all'>('open');
  const [sourceFilter, setSourceFilter] = useState<DocProposalSourceType | 'all'>('all');
  const [targetFilter, setTargetFilter] = useState<DocProposalTargetType | 'all'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.docUpdateProposals
      .list({ projectId, limit: 200 })
      .then(setProposals)
      .catch((err) => showError((err as Error).message || 'Failed to load proposals'))
      .finally(() => setLoading(false));
  }, [projectId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      proposals.filter(
        (p) =>
          (statusFilter === 'all' || p.status === statusFilter) &&
          (sourceFilter === 'all' || p.source.type === sourceFilter) &&
          (targetFilter === 'all' || p.target.type === targetFilter),
      ),
    [proposals, statusFilter, sourceFilter, targetFilter],
  );

  const openCount = proposals.filter((p) => p.status === 'open').length;

  const handleUpdateStatus = async (id: string, status: DocProposalStatus) => {
    setBusyId(id);
    try {
      await api.docUpdateProposals.updateStatus(id, { status });
      load();
    } catch (err) {
      showError((err as Error).message || 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleConvertToTodo = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.docUpdateProposals.convertToTodo(id);
      showSuccess(t('docsHealth.todoCreated', { displayNumber: res.todo.displayNumber }));
      load();
    } catch (err) {
      showError((err as Error).message || 'Convert failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-gray-400">
          {t('docsHealth.openCount')}: <span className="text-amber-300 font-medium">{openCount}</span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as DocProposalStatus | 'all')}
            className="bg-gray-900 border border-gray-800 rounded text-xs px-2 py-1 text-gray-300"
          >
            <option value="all">{t('docsHealth.filter.allStatus')}</option>
            <option value="open">{t('docsHealth.status.open')}</option>
            <option value="accepted">{t('docsHealth.status.accepted')}</option>
            <option value="converted_to_todo">{t('docsHealth.status.converted_to_todo')}</option>
            <option value="dismissed">{t('docsHealth.status.dismissed')}</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as DocProposalSourceType | 'all')}
            className="bg-gray-900 border border-gray-800 rounded text-xs px-2 py-1 text-gray-300"
          >
            <option value="all">{t('docsHealth.filter.allSources')}</option>
            <option value="todo">todo</option>
            <option value="commit">commit</option>
            <option value="release">release</option>
            <option value="workflow_run">workflow_run</option>
            <option value="manual">manual</option>
          </select>
          <select
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value as DocProposalTargetType | 'all')}
            className="bg-gray-900 border border-gray-800 rounded text-xs px-2 py-1 text-gray-300"
          >
            <option value="all">{t('docsHealth.filter.allTargets')}</option>
            <option value="knowledge">knowledge</option>
            <option value="manual">manual</option>
            <option value="doc_file">doc_file</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <EmptyState message={t('docsHealth.empty')} />
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <ProposalCard
              key={p._id}
              proposal={p}
              basePath={basePath}
              busy={busyId === p._id}
              onUpdateStatus={(s) => handleUpdateStatus(p._id, s)}
              onConvertToTodo={() => handleConvertToTodo(p._id)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}
