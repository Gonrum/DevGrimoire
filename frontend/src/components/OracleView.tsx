import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  OracleAffectedEntity,
  OracleRiskType,
  OracleSeverity,
  OracleSuggestion,
  OracleSuggestionStatus,
} from '../api/client';
import { useToast } from './Toast';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import { entityHref } from './knowledge-graph/entityTypeStyles';

interface Props {
  projectId: string;
  basePath: string;
}

const SEVERITY_COLORS: Record<OracleSeverity, string> = {
  critical: 'bg-red-900/40 text-red-300',
  warn: 'bg-amber-900/40 text-amber-300',
  info: 'bg-cyan-900/40 text-cyan-300',
};
const SEVERITY_ORDER: OracleSeverity[] = ['critical', 'warn', 'info'];
const STATUS_COLORS: Record<OracleSuggestionStatus, string> = {
  open: 'bg-gray-800 text-gray-300',
  dismissed: 'bg-gray-900 text-gray-500',
  converted_to_todo: 'bg-purple-900/40 text-purple-300',
  addressed: 'bg-green-900/40 text-green-300',
};
const TYPE_LABEL_KEY: Record<OracleRiskType, string> = {
  stagnation: 'oracle.type.stagnation',
  deadline_pressure: 'oracle.type.deadline_pressure',
  bug_hotspot: 'oracle.type.bug_hotspot',
  blocker_chain: 'oracle.type.blocker_chain',
};

function AffectedEntityLink({ entity, basePath }: { entity: OracleAffectedEntity; basePath: string }) {
  const href = entityHref(basePath, entity.entityType, entity.entityId);
  const label = (
    <>
      <span className="text-gray-500 mr-1">[{entity.entityType}]</span>
      {entity.label || entity.entityId.slice(-6)}
    </>
  );
  if (href) {
    return (
      <Link to={href} className="text-cyan-400 hover:underline text-xs">
        {label}
      </Link>
    );
  }
  return <span className="text-xs text-gray-300">{label}</span>;
}

function SuggestionCard({
  suggestion,
  basePath,
  busy,
  onDismiss,
  onConvert,
  onCommentOnTodo,
  onDelete,
  t,
}: {
  suggestion: OracleSuggestion;
  basePath: string;
  busy: boolean;
  onDismiss: () => void;
  onConvert: () => void;
  onCommentOnTodo: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const isOpen = suggestion.status === 'open';
  const todoId = suggestion.metadata?.todoId;
  const hasAffectedTodo = suggestion.affectedEntities.some((e) => e.entityType === 'todo');
  const visibleEntities = suggestion.affectedEntities.slice(0, 6);
  const hiddenCount = Math.max(0, suggestion.affectedEntities.length - visibleEntities.length);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={SEVERITY_COLORS[suggestion.severity]} rounded="full">
          {t(`oracle.severity.${suggestion.severity}`)}
        </Badge>
        <Badge color={STATUS_COLORS[suggestion.status]} rounded="full">
          {t(`oracle.status.${suggestion.status}`)}
        </Badge>
        <span className="text-xs text-gray-500 uppercase tracking-wide">
          {t(TYPE_LABEL_KEY[suggestion.type])}
        </span>
        <span className="text-xs text-gray-600 ml-auto">
          {new Date(suggestion.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="text-sm text-gray-100 font-medium leading-snug">{suggestion.title}</div>
      <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words leading-relaxed">
        {suggestion.reason}
      </pre>
      {suggestion.recommendedAction && (
        <div className="text-xs">
          <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-0.5">
            {t('oracle.recommendedAction')}
          </div>
          <pre className="text-gray-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2 text-xs leading-relaxed">
            {suggestion.recommendedAction}
          </pre>
        </div>
      )}
      {visibleEntities.length > 0 && (
        <div>
          <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">
            {t('oracle.affectedEntities')}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {visibleEntities.map((e) => (
              <AffectedEntityLink key={`${e.entityType}:${e.entityId}`} entity={e} basePath={basePath} />
            ))}
            {hiddenCount > 0 && (
              <span className="text-xs text-gray-600">+{hiddenCount}</span>
            )}
          </div>
        </div>
      )}
      {suggestion.status === 'converted_to_todo' && todoId && (
        <div className="text-xs text-gray-500">
          {t('oracle.convertedTo')}{' '}
          <Link to={`${basePath}/todos/${todoId}`} className="text-cyan-400 hover:underline">
            {t('oracle.openTodo')}
          </Link>
        </div>
      )}
      {isOpen && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="primary" disabled={busy} onClick={onConvert}>
            {t('oracle.convertToTodo')}
          </Button>
          {hasAffectedTodo && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onCommentOnTodo}>
              {t('oracle.commentOnTodo')}
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={onDismiss}>
            {t('oracle.dismiss')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onDelete} className="ml-auto">
            {t('oracle.delete')}
          </Button>
        </div>
      )}
      {!isOpen && (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-gray-600 hover:text-red-300"
          >
            {t('oracle.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function OracleView({ projectId, basePath }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [suggestions, setSuggestions] = useState<OracleSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<OracleSuggestionStatus | 'all'>('open');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.oracle
      .list({ projectId, limit: 500 })
      .then(setSuggestions)
      .catch((err) => showError((err as Error).message || 'Failed to load Oracle'))
      .finally(() => setLoading(false));
  }, [projectId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await api.oracle.analyze(projectId);
      showSuccess(t('oracle.analyzed', res as unknown as Record<string, number>));
      load();
    } catch (err) {
      showError((err as Error).message || 'Analyze failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDismiss = async (id: string) => {
    setBusyId(id);
    try {
      await api.oracle.updateStatus(id, { status: 'dismissed' });
      load();
    } catch (err) {
      showError((err as Error).message || 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleConvert = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.oracle.convertToTodo(id);
      showSuccess(t('oracle.todoCreated', { displayNumber: res.todo.displayNumber }));
      load();
    } catch (err) {
      showError((err as Error).message || 'Convert failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleCommentOnTodo = async (id: string) => {
    setBusyId(id);
    try {
      await api.oracle.commentOnTodo(id);
      showSuccess(t('oracle.commented'));
      load();
    } catch (err) {
      showError((err as Error).message || 'Comment failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await api.oracle.remove(id);
      load();
    } catch (err) {
      showError((err as Error).message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(
    () =>
      suggestions.filter((s) => statusFilter === 'all' || s.status === statusFilter),
    [suggestions, statusFilter],
  );

  const grouped = useMemo(() => {
    const map = new Map<OracleSeverity, OracleSuggestion[]>();
    for (const s of filtered) {
      if (!map.has(s.severity)) map.set(s.severity, []);
      map.get(s.severity)!.push(s);
    }
    return map;
  }, [filtered]);

  const openCount = suggestions.filter((s) => s.status === 'open').length;
  const criticalOpenCount = suggestions.filter((s) => s.status === 'open' && s.severity === 'critical').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-gray-400">
          {t('oracle.openCount')}:{' '}
          <span className="text-gray-200 font-medium">{openCount}</span>
        </span>
        {criticalOpenCount > 0 && (
          <span className="text-red-300">
            {t('oracle.severity.critical')}: <span className="font-semibold">{criticalOpenCount}</span>
          </span>
        )}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as OracleSuggestionStatus | 'all')}
          className="bg-gray-900 border border-gray-800 rounded text-xs px-2 py-1 text-gray-300"
        >
          <option value="all">{t('oracle.filter.allStatus')}</option>
          <option value="open">{t('oracle.status.open')}</option>
          <option value="dismissed">{t('oracle.status.dismissed')}</option>
          <option value="converted_to_todo">{t('oracle.status.converted_to_todo')}</option>
          <option value="addressed">{t('oracle.status.addressed')}</option>
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={analyzing}
          onClick={handleAnalyze}
          className="ml-auto"
        >
          {analyzing ? t('oracle.analyzing') : t('oracle.analyze')}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <EmptyState message={t('oracle.empty')}>
          <span className="block text-xs text-gray-600 mt-2">{t('oracle.emptyHint')}</span>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {SEVERITY_ORDER.map((severity) => {
            const items = grouped.get(severity) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={severity}>
                <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  {t(`oracle.severity.${severity}`)} · {items.length}
                </h3>
                <div className="space-y-2">
                  {items.map((s) => (
                    <SuggestionCard
                      key={s._id}
                      suggestion={s}
                      basePath={basePath}
                      busy={busyId === s._id}
                      onDismiss={() => handleDismiss(s._id)}
                      onConvert={() => handleConvert(s._id)}
                      onCommentOnTodo={() => handleCommentOnTodo(s._id)}
                      onDelete={() => handleDelete(s._id)}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
