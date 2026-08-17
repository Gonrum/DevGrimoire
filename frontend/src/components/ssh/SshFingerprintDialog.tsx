import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import { Dialog, Portal } from '../ui/Dialog';
import { errorMessage } from '../../lib/narrow';

interface SshFingerprintDialogProps {
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  mismatch?: boolean;
  onAccept: () => Promise<void> | void;
  onCancel: () => void;
}

/**
 * TOFU confirmation dialog (Spec §5.7).
 *
 * Renders inside a `Portal` so callers can drop it anywhere in the tree.
 * Async `onAccept` is awaited so the button stays disabled during the
 * `/accept-fingerprint` round-trip (prevents double-submit).
 */
export default function SshFingerprintDialog({
  host,
  port,
  username,
  fingerprint,
  mismatch = false,
  onAccept,
  onCancel,
}: SshFingerprintDialogProps) {
  const { t } = useTranslation();
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  /**
   * `onAccept` is typed `() => Promise<void> | void`, so a caller that does
   * *not* catch internally would previously have produced an unhandled
   * rejection and a silently stuck dialog. The rejection is caught here and
   * rendered, which is what makes the `void` at the call site honest.
   */
  const handleAccept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      await onAccept();
    } catch (err) {
      setAcceptError(errorMessage(err));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Portal>
      <Dialog title={t('ssh.fingerprint.title')} onClose={onCancel}>
        <div className="p-5 space-y-3">
          {mismatch && (
            <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-200">
              <div className="font-semibold mb-1">{t('ssh.fingerprint.mismatchTitle')}</div>
              <div className="text-xs text-red-200/90">
                {t('ssh.fingerprint.mismatchBody')}
              </div>
            </div>
          )}
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-gray-500">{t('ssh.field.host')}</span>
            <span className="text-gray-200">
              {username}@{host}:{port}
            </span>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">{t('ssh.fingerprint.sha256')}</div>
            <pre className="whitespace-pre-wrap break-all rounded bg-gray-950 border border-gray-800 px-3 py-2 font-mono text-xs text-violet-300">
              {fingerprint}
            </pre>
          </div>
          <p className="text-xs text-gray-500">{t('ssh.fingerprint.hint')}</p>
          {acceptError && (
            <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {acceptError}
            </div>
          )}
        </div>
        <div className="border-t border-gray-800 px-5 py-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={accepting}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleAccept()} disabled={accepting}>
            {accepting ? '…' : t('ssh.fingerprint.accept')}
          </Button>
        </div>
      </Dialog>
    </Portal>
  );
}
