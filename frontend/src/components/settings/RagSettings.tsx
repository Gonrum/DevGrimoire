import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import Button from '../ui/Button';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

export default function RagSettings() {
  const { t } = useTranslation();
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reindex = async () => {
    setReindexing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.rag.reindex();
      setSuccess(t('settings.ragReindexStarted', { count: result.indexed ?? 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.ragReindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <>
      <SettingsTabHeader description={t('settings.ragDescription')} />

      {error && <div className="mb-4 rounded border border-red-700 bg-red-900/50 px-4 py-2 text-red-300">{error}</div>}
      {success && <div className="mb-4 rounded border border-green-700 bg-green-900/40 px-4 py-2 text-green-300">{success}</div>}

      <SettingsSection title={t('settings.ragOptionsTitle')} description={t('settings.ragOptionsDescription')}>
        <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {t('settings.ragReindexWarning')}
        </div>

        <SettingsActions>
          <Button variant="primary" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? t('settings.ragReindexing') : t('settings.ragReindexNow')}
          </Button>
        </SettingsActions>
      </SettingsSection>
    </>
  );
}
