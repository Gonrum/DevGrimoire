import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SshAuditAction,
  SshAuditEntry,
  SshAuditSourceContext,
  SshConnectionListItem,
} from '../../api/client';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { LoadingText } from '../ui/LoadingSpinner';
import { Portal } from '../ui/Dialog';
import { optionOr } from '../../lib/narrow';
import { useSshAudit } from './hooks/useSshAudit';

const PAGE_SIZE = 50;
const DETAIL_TRUNCATE = 80;

const SOURCE_CONTEXT_VALUES = ['terminal', 'mcp', 'rest'] as const satisfies readonly SshAuditSourceContext[];

/**
 * The filter select adds an empty "all" option on top of the API values. Kept
 * as a value list so the change handler can *match* the incoming string
 * instead of asserting it — `HTMLSelectElement.value` is a plain `string`.
 */
const SOURCE_FILTER_VALUES = ['', ...SOURCE_CONTEXT_VALUES] as const satisfies readonly (
  | SshAuditSourceContext
  | ''
)[];

/**
 * Static (Tailwind-purge-safe) badge styling per source context. Spec §5.8
 * calls for visual distinction; the keys here are referenced by string from
 * the audit row renderer so we keep them inline rather than dynamic.
 */
const SOURCE_BADGE: Record<SshAuditSourceContext, string> = {
  terminal: 'bg-blue-900/40 text-blue-300',
  mcp: 'bg-violet-900/40 text-violet-300',
  rest: 'bg-gray-800 text-gray-400',
};

/** Action → icon mapping (spec §5.8). */
const ACTION_ICON: Record<SshAuditAction, string> = {
  connect: '🔌',
  exec: '▶',
  upload: '⬆',
  download: '⬇',
  list_files: '📁',
  terminal_open: '🖥',
  terminal_close: '🖥',
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Picks the most useful "detail" field for the row (command vs path vs —). */
function entryDetail(entry: SshAuditEntry): string {
  const raw = entry.command ?? entry.remotePath ?? '';
  return raw ? truncate(raw, DETAIL_TRUNCATE) : '—';
}

/** Result column: exit code, error, or em-dash. */
function entryResult(entry: SshAuditEntry, errorLabel: string): {
  text: string;
  tone: 'ok' | 'error' | 'neutral';
  title?: string;
} {
  if (entry.errorMsg) {
    return {
      text: `${errorLabel}: ${truncate(entry.errorMsg, 40)}`,
      tone: 'error',
      title: entry.errorMsg,
    };
  }
  if (typeof entry.exitCode === 'number') {
    return {
      text: `exit ${entry.exitCode}`,
      tone: entry.exitCode === 0 ? 'ok' : 'error',
    };
  }
  return { text: '—', tone: 'neutral' };
}

export interface SshAuditTabProps {
  open: boolean;
  onClose: () => void;
  connection: SshConnectionListItem;
}

/**
 * Audit-log viewer for a single SSH connection (Spec §5.8 / acceptance §7.7).
 *
 * Rendered as a wide Portal modal (the standard `Dialog` shell tops out at
 * `max-w-lg`, which is too narrow for the 6-column audit table). Opens from
 * the connection card's "📜 Audit" button.
 *
 * Filtering: only `sourceContext` is exposed because the backend endpoint
 * (`GET /api/ssh-connections/:id/audit`) supports just that query param. An
 * action filter would have to round-trip through the backend DTO first.
 *
 * Pagination: server-side, 50 per page. Caller-driven via `offset` — we
 * derive the current page from offset/PAGE_SIZE so a stale page index can't
 * out-pace `total` when filters change.
 */
export default function SshAuditTab({ open, onClose, connection }: SshAuditTabProps) {
  const { t } = useTranslation();
  const [sourceContext, setSourceContext] = useState<SshAuditSourceContext | ''>('');
  const [offset, setOffset] = useState(0);

  // Reset to first page on filter change. Implemented via a render-time
  // tracker so a filter+page race can't show entries from the prior filter
  // under the new page number.
  useFilterKeyTracker(sourceContext, () => setOffset(0));

  const { data, loading, error, reload } = useSshAudit(open ? connection.id : null, {
    limit: PAGE_SIZE,
    offset,
    sourceContext: sourceContext || undefined,
  });

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const canPrev = offset > 0;
  // Don't allow paging past the last full window. `total === 0` collapses to
  // a single empty page.
  const canNext = offset + PAGE_SIZE < total;

  const handlePrev = () => {
    setOffset((o) => Math.max(0, o - PAGE_SIZE));
  };
  const handleNext = () => {
    setOffset((o) => o + PAGE_SIZE);
  };

  const sourceOptions = useMemo(
    () => [
      { value: '', label: t('ssh.audit.filterAll') },
      ...SOURCE_CONTEXT_VALUES.map((v) => ({
        value: v,
        label: t(`ssh.audit.source.${v}`),
      })),
    ],
    [t],
  );

  if (!open) return null;

  return (
    <Portal>
      <div className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 max-w-5xl w-full mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-violet-500/10 border-b border-violet-500/30 px-5 py-3 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-violet-300 truncate">
            {t('ssh.audit.title', { label: connection.label })}
          </span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" aria-label={t('common.close')}>
            &times;
          </button>
        </div>

        {/* Filter bar */}
        <div className="px-5 py-3 border-b border-gray-800 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {t('ssh.audit.filterSource')}
            </label>
            <select
              value={sourceContext}
              onChange={(e) => setSourceContext(optionOr(e.target.value, SOURCE_FILTER_VALUES, ''))}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
            >
              {sourceOptions.map((opt) => (
                <option key={opt.value || 'all'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto text-xs text-gray-500">
            {total > 0
              ? t('ssh.audit.totalEntries', { count: total })
              : null}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && <LoadingText />}

          {error && !loading && (
            <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200 flex items-center justify-between gap-2">
              <span>{t('common.errorLoading', { error })}</span>
              {/* `reload()` surfaces its own failure via the `error` state that
                  renders this very banner → `void` is enough. */}
              <Button size="xs" variant="secondary" onClick={() => void reload()}>
                {t('ssh.audit.retry')}
              </Button>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <EmptyState message={t('ssh.audit.empty')} />
          )}

          {!loading && !error && items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.at')}</th>
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.source')}</th>
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.action')}</th>
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.detail')}</th>
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.result')}</th>
                    <th className="py-2 pr-3 font-normal">{t('ssh.audit.col.duration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((entry) => {
                    const result = entryResult(entry, t('ssh.audit.errorLabel'));
                    const resultClass =
                      result.tone === 'error'
                        ? 'text-red-300'
                        : result.tone === 'ok'
                          ? 'text-green-300'
                          : 'text-gray-500';
                    return (
                      <tr
                        key={entry._id}
                        className="border-b border-gray-900 hover:bg-gray-800/40"
                      >
                        <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                          {new Date(entry.at).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge color={SOURCE_BADGE[entry.sourceContext]}>
                            {t(`ssh.audit.source.${entry.sourceContext}`)}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-gray-300 whitespace-nowrap">
                          <span className="mr-1">{ACTION_ICON[entry.action]}</span>
                          {t(`ssh.audit.action.${entry.action}`)}
                        </td>
                        <td className="py-2 pr-3 text-gray-300 font-mono break-all">
                          <span title={entry.command ?? entry.remotePath ?? undefined}>
                            {entryDetail(entry)}
                          </span>
                          {typeof entry.bytes === 'number' && (
                            <span className="ml-2 text-gray-500 font-sans">
                              ({entry.bytes} B)
                            </span>
                          )}
                        </td>
                        <td className={`py-2 pr-3 whitespace-nowrap ${resultClass}`}>
                          <span title={result.title}>{result.text}</span>
                        </td>
                        <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                          {typeof entry.durationMs === 'number'
                            ? `${entry.durationMs} ms`
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="border-t border-gray-800 px-5 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-gray-500">
            {total > 0
              ? t('ssh.audit.pageOf', { current: currentPage, total: totalPages })
              : t('ssh.audit.noPages')}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={!canPrev || loading} onClick={handlePrev}>
              {t('ssh.audit.prev')}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canNext || loading} onClick={handleNext}>
              {t('ssh.audit.next')}
            </Button>
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * Tiny helper: when the supplied key changes between renders, fire `onChange`
 * once. Lives inline because it's only useful here — pure render-time
 * comparison via `useState`'s setter is React's documented pattern for
 * "reset state on prop change" without an extra effect cycle.
 */
function useFilterKeyTracker(key: string, onChange: () => void): void {
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    onChange();
  }
}
