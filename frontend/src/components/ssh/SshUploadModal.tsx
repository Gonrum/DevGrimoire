import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Dialog, Portal } from '../ui/Dialog';
import { FormInput } from '../ui/FormField';
import Button from '../ui/Button';
import { useToast } from '../Toast';

export interface SshUploadModalProps {
  connectionId: string;
  connectionLabel: string;
  onClose: () => void;
}

export default function SshUploadModal({ connectionId, connectionLabel, onClose }: SshUploadModalProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [remotePath, setRemotePath] = useState('');
  const [createDirs, setCreateDirs] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) {
      showError(t('ssh.upload.noFile'));
      return;
    }
    if (!remotePath.trim()) {
      showError(t('ssh.upload.noPath'));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const res = await api.ssh.uploadFile(
        connectionId,
        file,
        remotePath.trim(),
        { createDirs },
        (f) => setProgress(f),
      );
      showSuccess(t('ssh.upload.done', { bytes: res.bytesWritten }));
      onClose();
    } catch (e) {
      showError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Portal>
      <Dialog
        onClose={busy ? () => {} : onClose}
        title={t('ssh.upload.title', { label: connectionLabel })}
      >
        <div className="space-y-4">
          <input
            type="file"
            className="block w-full text-sm text-gray-300"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <FormInput
            label={t('ssh.upload.remotePath')}
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/var/www/app/artifact.tar.gz"
            disabled={busy}
          />
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={createDirs}
              onChange={(e) => setCreateDirs(e.target.checked)}
              disabled={busy}
            />
            {t('ssh.upload.createDirs')}
          </label>
          {progress !== null && (
            <div className="h-2 w-full rounded bg-gray-700">
              <div
                className="h-2 rounded bg-violet-500 transition-all"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            {/* `submit()` catches everything and reports via `showError` → the
                error path is inside, `void` only discards the settled promise. */}
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? t('ssh.upload.uploading') : t('ssh.upload.submit')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Portal>
  );
}
