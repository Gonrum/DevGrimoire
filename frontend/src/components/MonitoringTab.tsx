import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Healthcheck,
  HealthcheckHeader,
  HealthcheckHistoryEntry,
  HealthcheckMethod,
  HealthcheckSecretHeader,
  HealthcheckStatus,
  Project,
  SecretListItem,
  api,
} from '../api/client';
import { optionOr } from '../lib/narrow';
import { wsEventBus, isProjectChangeEvent } from '../api/wsEventBus';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';
import { Dialog, Portal } from './ui/Dialog';
import { FormInput, FormSelect, FormTextarea } from './ui/FormField';
import { LoadingText } from './ui/LoadingSpinner';
import { useToast } from './Toast';

const STATUS_COLORS: Record<HealthcheckStatus, string> = {
  healthy: 'bg-green-900/50 text-green-300',
  degraded: 'bg-yellow-900/50 text-yellow-300',
  unhealthy: 'bg-red-900/50 text-red-300',
  paused: 'bg-gray-800 text-gray-500',
  unknown: 'bg-gray-800 text-gray-400',
};

/*
 * `as const satisfies` statt `: HealthcheckMethod[]`: die Literale bleiben
 * erhalten, damit `optionOr` unten den Union-Typ liefert und der Cast
 * `e.target.value as HealthcheckMethod` entfällt. Die Liste ist damit zugleich
 * die Laufzeit-Whitelist des `<select>`.
 */
const METHODS = [
  'GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE',
] as const satisfies readonly HealthcheckMethod[];

interface MonitoringTabProps {
  customerId: string;
  projectsById: Map<string, Project>;
  linkedProjectIds: string[];
}

export default function MonitoringTab({
  customerId,
  projectsById,
  linkedProjectIds,
}: MonitoringTabProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [checks, setChecks] = useState<Healthcheck[]>([]);
  /**
   * Für welchen Kunden die angezeigte Liste geholt wurde — `null` = noch keine.
   * Ersetzt ein `loading`-Flag, das der Effect synchron gesetzt hat: der Zustand
   * „lädt" ist eine Ableitung, kein Effekt.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loading = loadedFor !== customerId;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Healthcheck | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, HealthcheckHistoryEntry[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const reload = useCallback(
    () =>
      api.monitoring
        .list(customerId)
        .then(setChecks)
        .catch((err: unknown) => { showError(err instanceof Error ? err.message : String(err)); })
        .finally(() => { setLoadedFor(customerId); }),
    [customerId, showError],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // T-352: Live-Update bei Status-Wechsel. Backend emittet healthcheck-Events
  // (entity: 'healthcheck', mit customerId) bei jedem Status-Transition im
  // executeCheck. Wir reloaden mit 300ms-Throttle, damit ein Scheduler-Cycle
  // der mehrere Checks parallel flippt nicht N list-Calls absetzt.
  const refetchTimer = useRef<number | null>(null);
  useEffect(() => {
    const scheduleReload = () => {
      if (refetchTimer.current !== null) return;
      refetchTimer.current = window.setTimeout(() => {
        refetchTimer.current = null;
        api.monitoring.list(customerId).then(setChecks).catch(() => {});
      }, 300);
    };
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (!isProjectChangeEvent(event)) return;
      if (event.entity !== 'healthcheck') return;
      if (event.customerId && event.customerId !== customerId) return;
      scheduleReload();
    });
    return () => {
      unsub();
      if (refetchTimer.current !== null) {
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
    };
  }, [customerId]);

  // Load secrets reachable for this customer (customer-owned + project-owned of linked projects).
  useEffect(() => {
    const projectIds = linkedProjectIds;
    // Jeder Teil-Request hat sein eigenes `.catch` — die Sammel-Promise kann
    // nicht mehr rejecten.
    void Promise.all([
      api.secrets.listForCustomer(customerId).catch(() => [] as SecretListItem[]),
      ...projectIds.map((pid) =>
        api.secrets.list(pid).catch(() => [] as SecretListItem[]),
      ),
    ]).then((parts) => {
      const flat = parts.flat();
      const seen = new Set<string>();
      const dedup: SecretListItem[] = [];
      for (const s of flat) {
        if (seen.has(s._id)) continue;
        seen.add(s._id);
        dedup.push(s);
      }
      setSecrets(dedup);
    });
  }, [customerId, linkedProjectIds]);

  const summary = useMemo(() => {
    const out = { total: checks.length, healthy: 0, degraded: 0, unhealthy: 0, paused: 0, unknown: 0 };
    for (const c of checks) {
      out[c.lastStatus]++;
    }
    return out;
  }, [checks]);

  const handleRun = async (id: string) => {
    setRunning(id);
    try {
      const updated = await api.monitoring.run(id);
      setChecks((prev) => prev.map((c) => (c._id === id ? updated : c)));
      if (expanded === id) {
        const h = await api.monitoring.history(id);
        setHistory((prev) => ({ ...prev, [id]: h }));
      }
      showSuccess(t('monitoring.runSuccess', { status: updated.lastStatus }));
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.monitoring.remove(id);
      setChecks((prev) => prev.filter((c) => c._id !== id));
      showSuccess(t('monitoring.deleted'));
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleExpanded = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!history[id]) {
      try {
        const h = await api.monitoring.history(id);
        setHistory((prev) => ({ ...prev, [id]: h }));
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleSaved = (saved: Healthcheck) => {
    setChecks((prev) => {
      const idx = prev.findIndex((c) => c._id === saved._id);
      if (idx === -1) return [saved, ...prev];
      const copy = [...prev];
      copy[idx] = saved;
      return copy;
    });
    setShowForm(false);
    setEditing(null);
  };

  if (loading) return <LoadingText />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium text-gray-200">{t('monitoring.title')}</h2>
          {summary.total > 0 && (
            <>
              {summary.healthy > 0 && <Badge color={STATUS_COLORS.healthy}>{summary.healthy} {t('monitoring.status.healthy')}</Badge>}
              {summary.degraded > 0 && <Badge color={STATUS_COLORS.degraded}>{summary.degraded} {t('monitoring.status.degraded')}</Badge>}
              {summary.unhealthy > 0 && <Badge color={STATUS_COLORS.unhealthy}>{summary.unhealthy} {t('monitoring.status.unhealthy')}</Badge>}
              {summary.paused > 0 && <Badge color={STATUS_COLORS.paused}>{summary.paused} {t('monitoring.status.paused')}</Badge>}
              {summary.unknown > 0 && <Badge color={STATUS_COLORS.unknown}>{summary.unknown} {t('monitoring.status.unknown')}</Badge>}
            </>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={() => { setEditing(null); setShowForm(true); }}>
          + {t('monitoring.newCheck')}
        </Button>
      </div>

      {checks.length === 0 ? (
        <EmptyState message={t('monitoring.empty')} />
      ) : (
        <div className="space-y-2">
          {checks.map((c) => {
            const project = c.projectId ? projectsById.get(c.projectId) : undefined;
            const isExpanded = expanded === c._id;
            return (
              <div
                key={c._id}
                className="border border-gray-800 rounded bg-gray-900/50 overflow-hidden"
              >
                <div className="p-3 flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium text-gray-200">{c.name}</span>
                      <Badge color={STATUS_COLORS[c.lastStatus]}>
                        {t(`monitoring.status.${c.lastStatus}`)}
                      </Badge>
                      <Badge color="bg-gray-800 text-gray-400">{c.method}</Badge>
                      {!c.active && (
                        <Badge color="bg-gray-800 text-gray-500">
                          {t('monitoring.inactive')}
                        </Badge>
                      )}
                      {project && (
                        <Badge color="bg-violet-900/40 text-violet-300">{project.name}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{c.url}</div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        {t('monitoring.field.interval')}: {Math.round(c.intervalSeconds / 60)} min
                      </span>
                      {c.lastRunAt && (
                        <span>
                          {t('monitoring.field.lastRun')}:{' '}
                          {new Date(c.lastRunAt).toLocaleString()}
                        </span>
                      )}
                      {c.lastLatencyMs !== undefined && (
                        <span>{c.lastLatencyMs} ms</span>
                      )}
                      {c.lastStatusCode !== undefined && (
                        <span>HTTP {c.lastStatusCode}</span>
                      )}
                      {c.consecutiveFailures > 0 && (
                        <span className="text-red-400">
                          {c.consecutiveFailures}× {t('monitoring.field.failures')}
                        </span>
                      )}
                    </div>
                    {c.lastError && (
                      <div className="text-xs text-red-400 mt-1 truncate" title={c.lastError}>
                        {c.lastError}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="success"
                      disabled={running === c._id}
                      onClick={() => { void handleRun(c._id); }}
                    >
                      {running === c._id ? '…' : t('monitoring.runNow')}
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => { void toggleExpanded(c._id); }}>
                      {isExpanded ? t('monitoring.hideHistory') : t('monitoring.showHistory')}
                    </Button>
                    <Button
                      size="xs"
                      variant="edit"
                      onClick={() => { setEditing(c); setShowForm(true); }}
                    >
                      {t('common.edit')}
                    </Button>
                    <ConfirmButton size="xs" onConfirm={() => handleDelete(c._id)} />
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-800 bg-gray-950/50 p-3">
                    <HistoryView entries={history[c._id]} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <Portal>
          <HealthcheckForm
            customerId={customerId}
            initial={editing}
            secrets={secrets}
            linkedProjectIds={linkedProjectIds}
            projectsById={projectsById}
            onSaved={handleSaved}
            onClose={() => { setShowForm(false); setEditing(null); }}
          />
        </Portal>
      )}
    </div>
  );
}

function HistoryView({ entries }: { entries: HealthcheckHistoryEntry[] | undefined }) {
  const { t } = useTranslation();
  if (!entries) return <LoadingText />;
  if (entries.length === 0) {
    return <div className="text-xs text-gray-500">{t('monitoring.noHistory')}</div>;
  }
  return (
    <div className="space-y-1 max-h-64 overflow-auto">
      {entries.map((e) => (
        <div key={e._id} className="flex items-center gap-2 text-xs">
          <Badge color={STATUS_COLORS[e.status]}>{t(`monitoring.status.${e.status}`)}</Badge>
          <span className="text-gray-500">{new Date(e.runAt).toLocaleString()}</span>
          {e.statusCode !== undefined && <span className="text-gray-400">HTTP {e.statusCode}</span>}
          {e.latencyMs !== undefined && <span className="text-gray-400">{e.latencyMs} ms</span>}
          {e.error && <span className="text-red-400 truncate" title={e.error}>{e.error}</span>}
        </div>
      ))}
    </div>
  );
}

interface FormProps {
  customerId: string;
  initial: Healthcheck | null;
  secrets: SecretListItem[];
  linkedProjectIds: string[];
  projectsById: Map<string, Project>;
  onSaved: (check: Healthcheck) => void;
  onClose: () => void;
}

function HealthcheckForm({
  customerId,
  initial,
  secrets,
  linkedProjectIds,
  projectsById,
  onSaved,
  onClose,
}: FormProps) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [method, setMethod] = useState<HealthcheckMethod>(initial?.method ?? 'GET');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [contentType, setContentType] = useState(initial?.contentType ?? 'application/json');
  const [intervalMinutes, setIntervalMinutes] = useState(
    initial ? Math.max(1, Math.round(initial.intervalSeconds / 60)) : 5,
  );
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 10000);
  const [expectedStatusInput, setExpectedStatusInput] = useState(
    (initial?.expectedStatus ?? []).join(','),
  );
  const [expectedContent, setExpectedContent] = useState(initial?.expectedContent ?? '');
  const [failureThreshold, setFailureThreshold] = useState(initial?.failureThreshold ?? 2);
  const [active, setActive] = useState(initial?.active ?? true);
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [headers, setHeaders] = useState<HealthcheckHeader[]>(initial?.headers ?? []);
  const [secretHeaders, setSecretHeaders] = useState<HealthcheckSecretHeader[]>(
    initial?.secretHeaders ?? [],
  );
  const [saving, setSaving] = useState(false);

  const linkedProjects = useMemo(
    () => linkedProjectIds.map((id) => projectsById.get(id)).filter((p): p is Project => !!p),
    [linkedProjectIds, projectsById],
  );

  const submit = async () => {
    setSaving(true);
    try {
      const expectedStatus = expectedStatusInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => !Number.isNaN(n) && n >= 100 && n <= 599);

      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        method,
        url: url.trim(),
        body: body || undefined,
        contentType: contentType || undefined,
        intervalSeconds: Math.max(60, intervalMinutes * 60),
        timeoutMs,
        expectedStatus,
        expectedContent: expectedContent || undefined,
        failureThreshold,
        active,
        projectId: projectId || undefined,
        headers: headers.filter((h) => h.name.trim().length > 0),
        secretHeaders: secretHeaders.filter((h) => h.name.trim().length > 0 && h.secretId),
      };

      const saved = initial
        ? await api.monitoring.update(initial._id, payload)
        : await api.monitoring.create(customerId, payload);
      onSaved(saved);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateHeader = (idx: number, patch: Partial<HealthcheckHeader>) => {
    setHeaders((prev) => prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  };
  const removeHeader = (idx: number) => setHeaders((prev) => prev.filter((_, i) => i !== idx));
  const updateSecretHeader = (idx: number, patch: Partial<HealthcheckSecretHeader>) => {
    setSecretHeaders((prev) => prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  };
  const removeSecretHeader = (idx: number) =>
    setSecretHeaders((prev) => prev.filter((_, i) => i !== idx));

  return (
    <Dialog
      title={initial ? t('monitoring.editCheck') : t('monitoring.newCheck')}
      onClose={onClose}
    >
      <div className="p-5 space-y-3 max-h-[80vh] overflow-y-auto">
        <FormInput
          label={t('monitoring.field.name')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <FormInput
          label={t('monitoring.field.url')}
          required
          placeholder="https://example.com/health"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <FormSelect
            label={t('monitoring.field.method')}
            value={method}
            onChange={(e) => setMethod(optionOr(e.target.value, METHODS, method))}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </FormSelect>
          <FormSelect
            label={t('monitoring.field.project')}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">—</option>
            {linkedProjects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </FormSelect>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormInput
            label={t('monitoring.field.intervalMinutes')}
            type="number"
            min={1}
            max={1440}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Math.max(1, Number(e.target.value) || 1))}
          />
          <FormInput
            label={t('monitoring.field.timeoutMs')}
            type="number"
            min={500}
            max={120000}
            step={500}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Math.max(500, Number(e.target.value) || 10000))}
          />
          <FormInput
            label={t('monitoring.field.failureThreshold')}
            type="number"
            min={1}
            max={20}
            value={failureThreshold}
            onChange={(e) => setFailureThreshold(Math.max(1, Number(e.target.value) || 2))}
          />
        </div>
        <FormInput
          label={t('monitoring.field.expectedStatus')}
          placeholder="200, 204"
          helpText={t('monitoring.expectedStatusHelp')}
          value={expectedStatusInput}
          onChange={(e) => setExpectedStatusInput(e.target.value)}
        />
        <FormInput
          label={t('monitoring.field.expectedContent')}
          placeholder='"ok" / "status":"healthy"'
          value={expectedContent}
          onChange={(e) => setExpectedContent(e.target.value)}
        />
        <FormTextarea
          label={t('monitoring.field.description')}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {/* Headers */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-gray-500">{t('monitoring.headers')}</label>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setHeaders((prev) => [...prev, { name: '', value: '' }])}
            >
              + {t('common.add')}
            </Button>
          </div>
          {headers.length === 0 && (
            <div className="text-xs text-gray-600">{t('monitoring.noHeaders')}</div>
          )}
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <input
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                placeholder="Header"
                value={h.name}
                onChange={(e) => updateHeader(i, { name: e.target.value })}
              />
              <input
                className="flex-[2] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                placeholder="Value"
                value={h.value}
                onChange={(e) => updateHeader(i, { value: e.target.value })}
              />
              <Button size="xs" variant="danger" onClick={() => removeHeader(i)}>×</Button>
            </div>
          ))}
        </div>

        {/* Secret headers */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-gray-500">{t('monitoring.secretHeaders')}</label>
            <Button
              size="xs"
              variant="secondary"
              disabled={secrets.length === 0}
              onClick={() =>
                setSecretHeaders((prev) => [...prev, { name: '', secretId: '' }])
              }
            >
              + {t('common.add')}
            </Button>
          </div>
          {secrets.length === 0 ? (
            <div className="text-xs text-gray-600">{t('monitoring.noSecretsAvailable')}</div>
          ) : (
            <div className="text-xs text-gray-500 mb-1">{t('monitoring.secretHeadersHelp')}</div>
          )}
          {secretHeaders.map((h, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <input
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                placeholder="Header (e.g. Authorization)"
                value={h.name}
                onChange={(e) => updateSecretHeader(i, { name: e.target.value })}
              />
              <select
                className="flex-[2] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                value={h.secretId}
                onChange={(e) => updateSecretHeader(i, { secretId: e.target.value })}
              >
                <option value="">—</option>
                {secrets.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.key}
                    {s.projectId ? ` (project)` : s.customerId ? ` (customer)` : ''}
                  </option>
                ))}
              </select>
              <Button size="xs" variant="danger" onClick={() => removeSecretHeader(i)}>×</Button>
            </div>
          ))}
        </div>

        {/* Body for non-GET methods */}
        {method !== 'GET' && method !== 'HEAD' && (
          <>
            <FormInput
              label={t('monitoring.field.contentType')}
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
            />
            <FormTextarea
              label={t('monitoring.field.body')}
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          {t('monitoring.field.active')}
        </label>
      </div>
      <div className="border-t border-gray-800 px-5 py-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => { void submit(); }}
          disabled={saving || !name.trim() || !url.trim()}
        >
          {saving ? '…' : initial ? t('common.save') : t('common.create')}
        </Button>
      </div>
    </Dialog>
  );
}
