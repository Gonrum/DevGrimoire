import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentAccessToken, SshConnectionListItem } from '../../api/client';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { LoadingText } from '../ui/LoadingSpinner';
import { useToast } from '../Toast';
import SshAuditTab from './SshAuditTab';
import SshConnectionForm from './SshConnectionForm';
import SshFingerprintDialog from './SshFingerprintDialog';
import SshTerminalModal from './SshTerminalModal';
import { deriveSshStatus, SSH_STATUS_VISUAL } from './sshStatus';
import { useSshConnections } from './hooks/useSshConnections';
import {
  useAcceptSshFingerprint,
  useTestSshConnection,
} from './hooks/useSshConnectionMutations';

export interface SshConnectionsTabProps {
  /** Exactly one of `customerId` / `projectId` must be set. */
  scope: { customerId?: string; projectId?: string };
}

/**
 * "Server" tab (Spec §5.2/§5.3). Lists SSH connections for the given scope,
 * lets the user open the create/edit form, run an ad-hoc test, and delete
 * (delete lives inside the edit-form's footer for now).
 *
 * `⚡ Connect` is rendered as a hint of the upcoming terminal modal (T-382)
 * but is wired to a no-op log line so the button is visible without
 * pretending to work.
 */
export default function SshConnectionsTab({ scope }: SshConnectionsTabProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const { data: connections, loading, error, reload } = useSshConnections(scope);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SshConnectionListItem | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [openTerminalConn, setOpenTerminalConn] = useState<SshConnectionListItem | null>(null);
  const [openAuditConn, setOpenAuditConn] = useState<SshConnectionListItem | null>(null);
  const [testConnection] = useTestSshConnection();
  const [acceptFingerprint] = useAcceptSshFingerprint();
  // When the quick-test surfaces a new (or mismatched) host key we render
  // the TOFU dialog directly in the tab — opening the edit-form would have
  // pushed the user into an unrelated modal without the dialog visible.
  const [pendingFingerprint, setPendingFingerprint] = useState<{
    conn: SshConnectionListItem;
    fingerprint: string;
    mismatch: boolean;
  } | null>(null);

  const handleQuickTest = async (conn: SshConnectionListItem) => {
    setTestingId(conn.id);
    try {
      const result = await testConnection(conn.id);
      if (result.fingerprint) {
        setPendingFingerprint({
          conn,
          fingerprint: result.fingerprint,
          mismatch: !!result.fingerprintMismatch,
        });
      } else if (result.ok) {
        showSuccess(t('ssh.form.testSuccess'));
      } else if (result.error) {
        showError(`${result.error.code}: ${result.error.message}`);
      }
      await reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId(null);
    }
  };

  const handleAcceptPendingFingerprint = async () => {
    if (!pendingFingerprint) return;
    try {
      await acceptFingerprint(
        pendingFingerprint.conn.id,
        pendingFingerprint.fingerprint,
      );
      setPendingFingerprint(null);
      showSuccess(t('ssh.fingerprint.accepted'));
      await reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelPendingFingerprint = () => {
    // Connection remains persisted in `fingerprint_pending`; just close.
    setPendingFingerprint(null);
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (conn: SshConnectionListItem) => {
    setEditing(conn);
    setFormOpen(true);
  };

  const handleSaved = async () => {
    await reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium text-gray-200">{t('ssh.tab.title')}</h2>
        <Button variant="primary" size="sm" onClick={openCreate}>
          + {t('ssh.tab.newServer')}
        </Button>
      </div>

      {loading && <LoadingText />}

      {error && !loading && (
        <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200">
          {t('common.errorLoading', { error })}
        </div>
      )}

      {!loading && !error && connections.length === 0 && (
        <EmptyState message={t('ssh.tab.empty')} />
      )}

      {!loading && connections.length > 0 && (
        <div className="space-y-2">
          {connections.map((conn) => {
            const status = deriveSshStatus(conn);
            const visual = SSH_STATUS_VISUAL[status];
            const lastError =
              conn.lastConnectError &&
              `${new Date(conn.lastConnectError.at).toLocaleString()}: ${conn.lastConnectError.message}`;
            return (
              <div
                key={conn.id}
                className="border border-gray-800 rounded bg-gray-900/50 p-3 flex flex-wrap items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-medium text-gray-200">{conn.label}</span>
                    <Badge color={visual.badgeClass}>
                      {visual.emoji} {t(visual.i18nKey)}
                    </Badge>
                    <Badge color="bg-gray-800 text-gray-400">
                      {conn.authMethod === 'key' ? '🔑' : '🔒'}{' '}
                      {t(`ssh.authMethod.${conn.authMethod}`)}
                    </Badge>
                    {conn.tags.map((tag) => (
                      <Badge key={tag} color="bg-violet-900/40 text-violet-300">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                  <div className="text-xs text-gray-600 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    <span>slug: {conn.slug}</span>
                    {conn.lastConnectedAt && (
                      <span>
                        {t('ssh.field.lastConnectedAt')}:{' '}
                        {new Date(conn.lastConnectedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {lastError && (
                    <div className="text-xs text-red-400 mt-1 truncate" title={lastError}>
                      {lastError}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(() => {
                    // Status-gating: fingerprint_pending blocks Connect because
                    // the backend would WS-close 4002 immediately. Render but
                    // disable with a tooltip — clearer than hiding the button.
                    // `never_tested` is allowed; first Connect populates the
                    // fingerprint via TOFU on the test flow, but if a user
                    // hasn't pressed Test we let the backend speak (it may
                    // also reject) and surface the WS close-code in the
                    // terminal.
                    const blocked = status === 'fingerprint_pending';
                    const tooltip = blocked
                      ? t('ssh.tab.connectBlockedFingerprint')
                      : undefined;
                    return (
                      <Button
                        size="xs"
                        variant="success"
                        disabled={blocked}
                        title={tooltip}
                        onClick={() => setOpenTerminalConn(conn)}
                      >
                        ⚡ {t('ssh.tab.connect')}
                      </Button>
                    );
                  })()}
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={testingId === conn.id}
                    onClick={() => handleQuickTest(conn)}
                  >
                    {testingId === conn.id ? '…' : t('ssh.tab.test')}
                  </Button>
                  <Button size="xs" variant="edit" onClick={() => openEdit(conn)}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setOpenAuditConn(conn)}
                    title={t('ssh.tab.audit')}
                  >
                    📜 {t('ssh.tab.audit')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        <SshConnectionForm
          scope={scope}
          initial={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {pendingFingerprint && (
        <SshFingerprintDialog
          host={pendingFingerprint.conn.host}
          port={pendingFingerprint.conn.port}
          username={pendingFingerprint.conn.username}
          fingerprint={pendingFingerprint.fingerprint}
          mismatch={pendingFingerprint.mismatch}
          onAccept={handleAcceptPendingFingerprint}
          onCancel={handleCancelPendingFingerprint}
        />
      )}

      {openTerminalConn && (
        <SshTerminalModal
          open={!!openTerminalConn}
          onClose={() => {
            setOpenTerminalConn(null);
            // refresh so lastConnectedAt + audit-driven status update reflect.
            reload();
          }}
          connection={openTerminalConn}
          authToken={getCurrentAccessToken()}
        />
      )}

      {openAuditConn && (
        <SshAuditTab
          open={!!openAuditConn}
          onClose={() => setOpenAuditConn(null)}
          connection={openAuditConn}
        />
      )}
    </div>
  );
}
