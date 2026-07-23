import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, SshUploadConfig } from '../../api/client';
import { SettingsSection, SettingsActions } from '../ui/SettingsShell';
import { FormInput } from '../ui/FormField';
import Button from '../ui/Button';
import { useToast } from '../Toast';

const MB = 1024 * 1024;

export default function SshSettings() {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [config, setConfig] = useState<SshUploadConfig | null>(null);
  const [mb, setMb] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.ssh
      .getConfig()
      .then((c) => {
        setConfig(c);
        setMb(String(Math.round(c.maxUploadBytes / MB)));
      })
      .catch((e) => showError(String(e instanceof Error ? e.message : e)));
  }, [showError]);

  const hardMaxMb = config ? Math.round(config.hardMaxBytes / MB) : 500;

  const save = async () => {
    const value = Number(mb);
    if (!Number.isFinite(value) || value < 1 || value > hardMaxMb) {
      showError(t('ssh.settings.invalid', { max: hardMaxMb }));
      return;
    }
    setSaving(true);
    try {
      const updated = await api.ssh.setConfig(Math.round(value * MB));
      setConfig(updated);
      setMb(String(Math.round(updated.maxUploadBytes / MB)));
      showSuccess(t('ssh.settings.saved'));
    } catch (e) {
      showError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t('ssh.settings.limitTitle')}
      description={t('ssh.settings.subtitle')}
    >
      <FormInput
        label={t('ssh.settings.limitLabel')}
        type="number"
        min={1}
        max={hardMaxMb}
        value={mb}
        onChange={(e) => setMb(e.target.value)}
        helpText={t('ssh.settings.limitHint', { max: hardMaxMb })}
      />
      <SettingsActions>
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </SettingsActions>
    </SettingsSection>
  );
}
