import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, BackupJob, BackupMode, BackupRestorePreview, BackupRetentionPreview, BackupSystemStatus } from '../../api/client';
import Button from '../ui/Button';
import { FormSelect } from '../ui/FormField';
import { SettingsActions, SettingsSection } from '../ui/SettingsShell';

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(value?: number) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusColor(status: BackupJob['status']) {
  switch (status) {
    case 'completed':
      return 'text-green-300 bg-green-900/30 border-green-800';
    case 'failed':
      return 'text-red-300 bg-red-900/30 border-red-800';
    default:
      return 'text-amber-300 bg-amber-900/30 border-amber-800';
  }
}

export default function BackupSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BackupSystemStatus | null>(null);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [mode, setMode] = useState<BackupMode>('full-system');
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [previewingRetention, setPreviewingRetention] = useState(false);
  const [previewingRestore, setPreviewingRestore] = useState(false);
  const [retentionPreview, setRetentionPreview] = useState<BackupRetentionPreview | null>(null);
  const [restorePreview, setRestorePreview] = useState<BackupRestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job._id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId],
  );

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextJobs] = await Promise.all([
        api.backups.status(),
        api.backups.list(25),
      ]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      setSelectedJobId((current) => {
        if (current && nextJobs.some((job) => job._id === current)) return current;
        return nextJobs[0]?._id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.backups.loadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const createBackup = async () => {
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const job = await api.backups.create({ mode, includeAttachments });
      setSuccess(t('settings.backups.backupStarted'));
      await load(true);
      setSelectedJobId(job._id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.backups.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const previewRetention = async () => {
    setPreviewingRetention(true);
    setError(null);
    setSuccess(null);
    try {
      setRetentionPreview(await api.backups.retentionPreview());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.backups.retentionPreviewFailed'));
    } finally {
      setPreviewingRetention(false);
    }
  };

  const previewRestore = async () => {
    if (!selectedJob) return;
    setPreviewingRestore(true);
    setError(null);
    setSuccess(null);
    try {
      setRestorePreview(await api.backups.restorePreview(selectedJob._id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.backups.restorePreviewFailed'));
    } finally {
      setPreviewingRestore(false);
    }
  };

  if (loading) {
    return <div className="py-10 text-center text-gray-500">{t('common.loading')}</div>;
  }

  return (
    <div className="space-y-6">
      <p className="text-gray-400">{t('settings.backups.description')}</p>

      {error && (
        <div className="rounded border border-red-700 bg-red-900/50 px-4 py-2 text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded border border-green-700 bg-green-900/30 px-4 py-2 text-green-300">
          {success}
        </div>
      )}

      <SettingsSection title={t('settings.backups.targetTitle')} description={t('settings.backups.targetDescription')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
            <div className="text-xs text-gray-500">{t('settings.backups.minio')}</div>
            <div className={status?.minioEnabled ? 'text-green-300' : 'text-red-300'}>
              {status?.minioEnabled ? t('settings.backups.available') : t('settings.backups.notConfigured')}
            </div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
            <div className="text-xs text-gray-500">{t('settings.backups.bucket')}</div>
            <div className="break-all text-gray-200">{status?.bucket || '—'}</div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
            <div className="text-xs text-gray-500">{t('settings.backups.schedule')}</div>
            <div className="font-mono text-gray-200">{status?.enabled ? status.schedule : t('settings.backups.disabled')}</div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
            <div className="text-xs text-gray-500">{t('settings.backups.currentState')}</div>
            <div className={status?.running ? 'text-amber-300' : 'text-green-300'}>
              {status?.running ? t('settings.backups.running') : t('settings.backups.idle')}
            </div>
          </div>
        </div>
        <div className="mt-3 rounded border border-gray-800 bg-gray-900/40 p-3 text-sm text-gray-300">
          {t('settings.backups.retentionPolicy', {
            keepLast: status?.retention?.keepLast ?? 14,
            keepDays: status?.retention?.keepDays ?? 30,
          })}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.backups.manualTitle')} description={t('settings.backups.manualDescription')}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
          <FormSelect
            label={t('settings.backups.mode')}
            value={mode}
            onChange={(e) => {
              const nextMode = e.target.value as BackupMode;
              setMode(nextMode);
              if (nextMode === 'full-system') setIncludeAttachments(true);
            }}
          >
            <option value="full-system">{t('settings.backups.modeFullSystem')}</option>
            <option value="database">{t('settings.backups.modeDatabase')}</option>
          </FormSelect>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={includeAttachments}
              onChange={(e) => setIncludeAttachments(e.target.checked)}
              className="h-4 w-4 accent-cyan-500"
            />
            {t('settings.backups.includeAttachments')}
          </label>
          <Button onClick={createBackup} disabled={creating || status?.running || !status?.minioEnabled} variant="primary">
            {creating ? t('settings.backups.starting') : t('settings.backups.startBackup')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.backups.retentionPreviewTitle')}
        description={t('settings.backups.retentionPreviewDescription')}
        meta={<Button size="sm" onClick={previewRetention} disabled={previewingRetention || !status?.minioEnabled}>{previewingRetention ? '…' : t('settings.backups.runRetentionPreview')}</Button>}
      >
        {retentionPreview ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
              <div className="text-xs text-gray-500">{t('settings.backups.deleteJobCount')}</div>
              <div className="text-gray-200">{retentionPreview.deleteJobCount}</div>
            </div>
            <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
              <div className="text-xs text-gray-500">{t('settings.backups.deleteObjectCount')}</div>
              <div className="text-gray-200">{retentionPreview.deleteObjectCount}</div>
            </div>
            <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
              <div className="text-xs text-gray-500">{t('settings.backups.dryRun')}</div>
              <div className="text-green-300">{retentionPreview.dryRun ? t('settings.backups.dryRunYes') : '—'}</div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">{t('settings.backups.noRetentionPreview')}</div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.backups.jobsTitle')}
        description={t('settings.backups.jobsDescription')}
        meta={<Button size="sm" onClick={() => load(true)} disabled={refreshing}>{refreshing ? '…' : t('common.update')}</Button>}
      >
        {jobs.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">{t('settings.backups.noJobs')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">{t('common.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings.backups.started')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings.backups.mode')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings.backups.trigger')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings.backups.artifacts')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job._id}
                    onClick={() => setSelectedJobId(job._id)}
                    className={`cursor-pointer border-b border-gray-900 hover:bg-gray-800/50 ${selectedJob?._id === job._id ? 'bg-violet-900/20' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className={`rounded border px-2 py-0.5 text-xs ${statusColor(job.status)}`}>
                        {t(`settings.backups.status_${job.status}`)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-300">{formatDate(job.startedAt ?? job.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-300">{t(`settings.backups.mode_${job.mode}`)}</td>
                    <td className="px-3 py-2 text-gray-400">{t(`settings.backups.trigger_${job.trigger}`)}</td>
                    <td className="px-3 py-2 text-gray-400">{job.manifest?.artifacts?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {selectedJob && (
        <SettingsSection title={t('settings.backups.manifestTitle')} description={selectedJob.objectPrefix}>
          <div className="space-y-4">
            {selectedJob.error && (
              <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-300">
                {selectedJob.error}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded bg-gray-900/70 p-3">
                <div className="text-xs text-gray-500">{t('settings.backups.finished')}</div>
                <div className="text-gray-200">{formatDate(selectedJob.finishedAt)}</div>
              </div>
              <div className="rounded bg-gray-900/70 p-3">
                <div className="text-xs text-gray-500">{t('settings.backups.includes')}</div>
                <div className="text-gray-200">
                  {selectedJob.manifest?.includes?.database ? t('settings.backups.database') : '—'}
                  {selectedJob.manifest?.includes?.attachments ? `, ${t('settings.backups.attachments')}` : ''}
                </div>
              </div>
              <div className="rounded bg-gray-900/70 p-3">
                <div className="text-xs text-gray-500">{t('settings.backups.restorePreview')}</div>
                <div className="text-gray-200">{selectedJob.manifest?.restore?.note ?? t('settings.backups.noRestoreNote')}</div>
              </div>
            </div>

            <div className="rounded border border-gray-800 bg-gray-900/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium text-gray-300">{t('settings.backups.restorePreviewCheckTitle')}</h4>
                  <p className="text-xs text-gray-500">{t('settings.backups.restorePreviewCheckDescription')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={previewRestore}
                  disabled={previewingRestore || selectedJob.status !== 'completed' || !status?.minioEnabled}
                >
                  {previewingRestore ? '…' : t('settings.backups.runRestorePreview')}
                </Button>
              </div>
              {restorePreview && restorePreview.jobId === selectedJob._id && (
                <div className="mt-3 space-y-2 text-sm">
                  <div className={restorePreview.ok ? 'text-green-300' : 'text-red-300'}>
                    {restorePreview.ok ? t('settings.backups.restorePreviewOk') : t('settings.backups.restorePreviewNotOk')}
                  </div>
                  <div className="text-xs text-gray-500">
                    {t('settings.backups.restorePreviewArtifactCount', { count: restorePreview.artifactCount })}
                  </div>
                  <div className="max-h-48 space-y-1 overflow-auto">
                    {restorePreview.checks.map((check) => (
                      <div key={check.key} className="flex flex-wrap items-center gap-2 rounded bg-gray-950/60 px-2 py-1 text-xs">
                        <span className={check.exists && check.sizeMatches && check.sha256Matches ? 'text-green-300' : 'text-red-300'}>
                          {check.exists && check.sizeMatches && check.sha256Matches ? '✓' : '!' }
                        </span>
                        <span className="break-all font-mono text-gray-300">{check.key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium text-gray-300">{t('settings.backups.artifacts')}</h4>
              <div className="space-y-2">
                {(selectedJob.manifest?.artifacts ?? []).map((artifact) => (
                  <div key={artifact.key} className="rounded border border-gray-800 bg-gray-900/50 p-3">
                    <div className="break-all font-mono text-xs text-cyan-300">{artifact.key}</div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                      <span>{formatBytes(artifact.size)}</span>
                      <span>{artifact.contentType}</span>
                      <span className="font-mono">sha256:{artifact.sha256.slice(0, 16)}…</span>
                    </div>
                  </div>
                ))}
                {(selectedJob.manifest?.artifacts ?? []).length === 0 && (
                  <div className="text-sm text-gray-500">{t('settings.backups.noArtifacts')}</div>
                )}
              </div>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsActions>
        <span className="text-xs text-gray-500">{t('settings.backups.restoreSafety')}</span>
      </SettingsActions>
    </div>
  );
}
