import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, WorkspaceLimitsConfig } from '../../api/client';
import { SettingsSection, SettingsActions } from '../ui/SettingsShell';
import { FormInput } from '../ui/FormField';
import Button from '../ui/Button';
import { useToast } from '../Toast';

const MB = 1024 * 1024;

const toMb = (bytes: number): string => String(Math.round((bytes / MB) * 100) / 100);

/** Editor and download limits of the browser IDE and the terminal idle limit (global, admin only). */
export default function WorkspaceSettings() {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [config, setConfig] = useState<WorkspaceLimitsConfig | null>(null);
  const [editorMb, setEditorMb] = useState('');
  const [downloadMb, setDownloadMb] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (c: WorkspaceLimitsConfig) => {
    setConfig(c);
    setEditorMb(toMb(c.editorMaxBytes));
    setDownloadMb(toMb(c.downloadMaxBytes));
    setIdleMinutes(String(c.terminalIdleMinutes));
  };

  useEffect(() => {
    api.workspaceConfig
      .get()
      .then(apply)
      .catch((e) => showError(String(e instanceof Error ? e.message : e)));
  }, [showError]);

  const editorHardMb = config ? Math.round(config.editorHardMaxBytes / MB) : 100;
  const downloadHardMb = config ? Math.round(config.downloadHardMaxBytes / MB) : 51200;
  const idleMin = config?.terminalIdleMinMinutes ?? 5;
  const idleMax = config?.terminalIdleMaxMinutes ?? 1440;

  const save = async () => {
    const editor = Number(editorMb);
    const download = Number(downloadMb);
    if (!Number.isFinite(editor) || editor < 1 || editor > editorHardMb) {
      showError(t('workspaceSettings.invalid', { max: editorHardMb }));
      return;
    }
    if (!Number.isFinite(download) || download < 1 || download > downloadHardMb) {
      showError(t('workspaceSettings.invalid', { max: downloadHardMb }));
      return;
    }
    const idle = Number(idleMinutes);
    if (!Number.isInteger(idle) || idle < idleMin || idle > idleMax) {
      showError(t('workspaceSettings.idleInvalid', { min: idleMin, max: idleMax }));
      return;
    }
    setSaving(true);
    try {
      apply(await api.workspaceConfig.set({
        editorMaxBytes: Math.round(editor * MB),
        downloadMaxBytes: Math.round(download * MB),
        terminalIdleMinutes: idle,
      }));
      showSuccess(t('workspaceSettings.saved'));
    } catch (e) {
      showError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t('workspaceSettings.title')}
      description={t('workspaceSettings.subtitle')}
    >
      <FormInput
        label={t('workspaceSettings.editorLabel')}
        type="number"
        min={1}
        max={editorHardMb}
        value={editorMb}
        onChange={(e) => setEditorMb(e.target.value)}
        helpText={t('workspaceSettings.editorHint', {
          def: config ? toMb(config.editorDefaultBytes) : '5',
          max: editorHardMb,
        })}
      />
      <FormInput
        label={t('workspaceSettings.downloadLabel')}
        type="number"
        min={1}
        max={downloadHardMb}
        value={downloadMb}
        onChange={(e) => setDownloadMb(e.target.value)}
        helpText={t('workspaceSettings.downloadHint', {
          def: config ? toMb(config.downloadDefaultBytes) : '2048',
          max: downloadHardMb,
        })}
      />
      <FormInput
        label={t('workspaceSettings.idleLabel')}
        type="number"
        min={idleMin}
        max={idleMax}
        step={1}
        value={idleMinutes}
        onChange={(e) => setIdleMinutes(e.target.value)}
        helpText={t('workspaceSettings.idleHint', {
          def: config?.terminalIdleDefaultMinutes ?? 30,
          min: idleMin,
          max: idleMax,
        })}
      />
      <SettingsActions>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </SettingsActions>
    </SettingsSection>
  );
}
