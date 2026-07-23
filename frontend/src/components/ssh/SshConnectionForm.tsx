import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  SecretListItem,
  SshConnectionCreateInput,
  SshConnectionListItem,
  SshConnectionUpdateInput,
  SshTestResult,
} from '../../api/client';
import Button from '../ui/Button';
import ConfirmButton from '../ui/ConfirmButton';
import { Dialog, Portal } from '../ui/Dialog';
import { FormInput, FormSelect, FormTextarea, SecretInput } from '../ui/FormField';
import TagInput from '../ui/TagInput';
import { useToast } from '../Toast';
import SshFingerprintDialog from './SshFingerprintDialog';
import {
  useCreateSshConnection,
  useDeleteSshConnection,
  useAcceptSshFingerprint,
  useTestSshConnection,
  useUpdateSshConnection,
} from './hooks/useSshConnectionMutations';
import { useSshConnection } from './hooks/useSshConnection';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** kebab-case, 3–60 chars, [a-z0-9-]. Matches backend `SSH_SLUG_REGEX`. */
function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 60 && SLUG_RE.test(slug);
}

function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

type AuthTab = 'key' | 'password';
type CredentialMode = 'inline' | 'pick';

export interface SshConnectionFormProps {
  scope: { customerId?: string; projectId?: string };
  /** If passed, the form opens in edit-mode on this connection. */
  initial?: SshConnectionListItem | null;
  onClose: () => void;
  /** Called after the full create-or-edit flow resolves (incl. fingerprint accept). */
  onSaved: () => void;
}

/**
 * Create-or-edit modal for an SSH connection (Spec §5.4).
 *
 * Create flow (atomic on the backend):
 *   1. POST `/ssh-connections` with `inlineSecrets` *or* secret IDs.
 *   2. Auto-trigger POST `/test`.
 *   3. On success-with-fingerprint → show fingerprint dialog → on accept,
 *      POST `/accept-fingerprint`. Cancel leaves the connection persisted
 *      with `fingerprint_pending` status (Spec §5.4 step 6 — the modal can
 *      be closed without accept; the user can re-test later).
 *   4. On test-error: keep the modal open with an inline error message and
 *      switch into edit-mode on the freshly-created connection so the user
 *      can fix host/username/auth and retry without losing context.
 *
 * Edit flow:
 *   - PATCH only writes metadata. Credential rotation goes through a
 *     separate "Credentials ändern" confirm so the user explicitly opts in
 *     (replacing owned Secrets is destructive).
 *   - `/test` is manual via the "Test" button — no auto-test on save.
 */
export default function SshConnectionForm({
  scope,
  initial,
  onClose,
  onSaved,
}: SshConnectionFormProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();

  // ----- Server-state for edit-mode (loads detail with credential refs) -----
  const [editingId, setEditingId] = useState<string | null>(initial?.id ?? null);
  const { data: detail } = useSshConnection(editingId);
  const isEdit = !!editingId;

  // ----- Form fields --------------------------------------------------------
  const [label, setLabel] = useState(initial?.label ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState<number>(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? '');
  // `detail` is always null at mount (async fetch). The useEffect below
  // syncs the description once the detail-fetch resolves.
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [notifyOnAuthFailure, setNotifyOnAuthFailure] = useState<boolean>(
    initial?.notifyOnAuthFailure ?? false,
  );
  const [maxUploadMb, setMaxUploadMb] = useState<string>(
    initial?.maxUploadBytes ? String(Math.round(initial.maxUploadBytes / (1024 * 1024))) : '',
  );

  const [authTab, setAuthTab] = useState<AuthTab>(initial?.authMethod ?? 'key');
  // In create-mode the user picks inline-vs-pick. In edit-mode credentials are
  // locked behind the explicit "Credentials ändern" confirm.
  const [credMode, setCredMode] = useState<CredentialMode>('inline');
  const [credentialsUnlocked, setCredentialsUnlocked] = useState(!isEdit);

  // Quick-create fields.
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');

  // Pick-existing fields.
  const [privateKeySecretId, setPrivateKeySecretId] = useState<string>('');
  const [passphraseSecretId, setPassphraseSecretId] = useState<string>('');
  const [passwordSecretId, setPasswordSecretId] = useState<string>('');

  // Sync description + upload override once the detail-fetch resolves in edit-mode.
  useEffect(() => {
    if (detail) {
      setDescription(detail.description ?? '');
      setMaxUploadMb(
        detail.maxUploadBytes
          ? String(Math.round(detail.maxUploadBytes / (1024 * 1024)))
          : '',
      );
    }
  }, [detail]);

  // ----- Secrets dropdown (Pick-Existing) -----------------------------------
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = scope.customerId
          ? await api.secrets.listForCustomer(scope.customerId)
          : await api.secrets.list(scope.projectId!);
        if (!cancelled) setSecrets(list);
      } catch {
        if (!cancelled) setSecrets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope.customerId, scope.projectId]);

  // Backend creates inline secrets as `type='ssh_key'` for the private key and
  // `type='password'` for both the passphrase and the password (the SecretType
  // enum has no `ssh_password`). Filter conservatively.
  const keySecrets = useMemo(() => secrets.filter((s) => s.type === 'ssh_key'), [secrets]);
  const passwordSecrets = useMemo(
    () => secrets.filter((s) => s.type === 'password' || s.type === 'token'),
    [secrets],
  );

  // ----- Mutations ----------------------------------------------------------
  const [createConnection, createState] = useCreateSshConnection();
  const [updateConnection, updateState] = useUpdateSshConnection();
  const [deleteConnection] = useDeleteSshConnection();
  const [testConnection, testState] = useTestSshConnection();
  const [acceptFingerprint] = useAcceptSshFingerprint();

  // ----- Test result + fingerprint dialog state ----------------------------
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [fpDialog, setFpDialog] = useState<{
    fingerprint: string;
    mismatch: boolean;
    connectionId: string;
  } | null>(null);

  // ----- Auto-slug from label (until user touches the slug field) ----------
  const onLabelChange = (next: string) => {
    setLabel(next);
    if (!slugTouched) {
      setSlug(slugifyLabel(next));
    }
  };

  // ----- Submit-helpers -----------------------------------------------------
  const slugError = useMemo(() => {
    if (!slug) {
      // If the user has typed a label (e.g. only emoji / whitespace), the
      // auto-slugifier produced an empty string and there's no inline hint
      // yet. Surface that explicitly so the user knows the label needs
      // ASCII characters.
      return label.trim().length > 0 ? t('ssh.form.slugCouldNotBeGenerated') : null;
    }
    return isValidSlug(slug) ? null : t('ssh.form.slugInvalid');
  }, [slug, label, t]);

  const formIsValid =
    label.trim().length > 0 &&
    isValidSlug(slug) &&
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    port >= 1 &&
    port <= 65535;

  const credentialsAreValid = (): boolean => {
    if (isEdit && !credentialsUnlocked) return true; // metadata-only patch
    if (credMode === 'inline') {
      if (authTab === 'key') return privateKey.trim().length > 0;
      return password.length > 0;
    }
    // pick-existing
    if (authTab === 'key') return !!privateKeySecretId;
    return !!passwordSecretId;
  };

  const buildCreatePayload = (): SshConnectionCreateInput => {
    const payload: SshConnectionCreateInput = {
      label: label.trim(),
      slug: slug.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod: authTab,
      description: description.trim() || undefined,
      tags,
      notifyOnAuthFailure,
      ...(scope.customerId ? { customerId: scope.customerId } : {}),
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    };

    if (credMode === 'inline') {
      if (authTab === 'key') {
        payload.inlineSecrets = {
          key: {
            privateKey: privateKey.trim(),
            ...(passphrase ? { passphrase } : {}),
          },
        };
      } else {
        payload.inlineSecrets = { password: { password } };
      }
    } else if (authTab === 'key') {
      payload.privateKeySecretId = privateKeySecretId;
      if (passphraseSecretId) payload.passphraseSecretId = passphraseSecretId;
    } else {
      payload.passwordSecretId = passwordSecretId;
    }
    return payload;
  };

  const handleTestResult = async (connectionId: string, result: SshTestResult) => {
    if (result.fingerprint) {
      setFpDialog({
        fingerprint: result.fingerprint,
        mismatch: !!result.fingerprintMismatch,
        connectionId,
      });
      return;
    }
    if (!result.ok && result.error) {
      // Test failed without a fingerprint to accept — surface inline.
      setInlineError(
        t('ssh.form.testFailed', {
          reason: `${result.error.code}: ${result.error.message}`,
        }),
      );
      return;
    }
    // ok=true without fingerprint = already accepted earlier (re-test) → done.
    showSuccess(t('ssh.form.testSuccess'));
    onSaved();
    onClose();
  };

  const submitCreate = async () => {
    setInlineError(null);
    try {
      const created = await createConnection(buildCreatePayload());
      // Switch into edit-mode on the new id so a failed test leaves us with
      // a working modal on the persisted connection.
      setEditingId(created.id);
      setCredentialsUnlocked(false);
      const result = await testConnection(created.id);
      await handleTestResult(created.id, result);
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitEdit = async () => {
    if (!editingId) return;
    setInlineError(null);
    try {
      const patch: SshConnectionUpdateInput = {
        label: label.trim(),
        slug: slug.trim(),
        host: host.trim(),
        port,
        username: username.trim(),
        description: description.trim() || undefined,
        tags,
        notifyOnAuthFailure,
        maxUploadBytes:
          maxUploadMb.trim() === ''
            ? undefined
            : Math.round(Number(maxUploadMb) * 1024 * 1024),
      };
      // Credential rotation — only when the user explicitly unlocked the
      // credentials section via the "Credentials ändern" confirm. Mirrors
      // `buildCreatePayload()` so the backend sees the same nested shape.
      if (credentialsUnlocked) {
        if (credMode === 'inline') {
          if (authTab === 'key') {
            patch.inlineSecrets = {
              key: {
                privateKey: privateKey.trim(),
                ...(passphrase ? { passphrase } : {}),
              },
            };
          } else {
            patch.inlineSecrets = { password: { password } };
          }
        } else if (authTab === 'key') {
          patch.privateKeySecretId = privateKeySecretId;
          if (passphraseSecretId) patch.passphraseSecretId = passphraseSecretId;
        } else {
          patch.passwordSecretId = passwordSecretId;
        }
        patch.authMethod = authTab;
      }
      await updateConnection(editingId, patch);
      showSuccess(t('ssh.form.saved'));
      onSaved();
      onClose();
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleManualTest = async () => {
    if (!editingId) return;
    setInlineError(null);
    try {
      const result = await testConnection(editingId);
      await handleTestResult(editingId, result);
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAcceptFingerprint = async () => {
    if (!fpDialog) return;
    try {
      await acceptFingerprint(fpDialog.connectionId, fpDialog.fingerprint);
      setFpDialog(null);
      showSuccess(t('ssh.fingerprint.accepted'));
      onSaved();
      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelFingerprint = () => {
    setFpDialog(null);
    // Connection stays persisted with `fingerprint_pending`. Refresh list and
    // close the modal so user sees the new entry with the pending badge.
    onSaved();
    onClose();
  };

  const handleDelete = async () => {
    if (!editingId) return;
    try {
      await deleteConnection(editingId);
      showSuccess(t('ssh.form.deleted'));
      onSaved();
      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const pending = createState.pending || updateState.pending || testState.pending;
  // `credentialsAreValid()` already short-circuits to true for an
  // edit-mode patch that doesn't rotate credentials, so we always call it.
  const submitDisabled =
    pending || !formIsValid || !credentialsAreValid() || !!slugError;

  return (
    <>
      <Portal>
        <Dialog
          title={
            isEdit ? t('ssh.form.titleEdit') : t('ssh.form.titleCreate')
          }
          onClose={onClose}
        >
          <div className="p-5 space-y-3 max-h-[80vh] overflow-y-auto">
            {inlineError && (
              <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200">
                {inlineError}
              </div>
            )}

            <FormInput
              label={t('ssh.form.label')}
              required
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder={t('ssh.form.labelPlaceholder')}
            />
            <FormInput
              label={t('ssh.form.slug')}
              required
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              helpText={t('ssh.form.slugHelp')}
              error={slugError}
            />
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <FormInput
                label={t('ssh.field.host')}
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com"
              />
              <FormInput
                label={t('ssh.field.port')}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) =>
                  setPort(Math.min(65535, Math.max(1, Number(e.target.value) || 22)))
                }
              />
            </div>
            <FormInput
              label={t('ssh.field.username')}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <FormTextarea
              label={t('common.description')}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('common.tags')}</label>
              <TagInput value={tags} onChange={setTags} placeholder={t('ssh.form.tagsPlaceholder')} />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={notifyOnAuthFailure}
                onChange={(e) => setNotifyOnAuthFailure(e.target.checked)}
              />
              {t('ssh.form.notifyOnAuthFailure')}
            </label>

            {isEdit && (
              <FormInput
                label={t('ssh.form.maxUpload')}
                type="number"
                min={1}
                max={500}
                value={maxUploadMb}
                onChange={(e) => setMaxUploadMb(e.target.value)}
                helpText={t('ssh.form.maxUploadHint')}
              />
            )}

            {/* Auth-method tabs */}
            <div className="border-t border-gray-800 pt-3">
              <div className="flex gap-1 mb-3">
                <Button
                  size="sm"
                  variant={authTab === 'key' ? 'primary' : 'secondary'}
                  onClick={() => setAuthTab('key')}
                  disabled={isEdit && !credentialsUnlocked}
                >
                  🔑 {t('ssh.form.authKey')}
                </Button>
                <Button
                  size="sm"
                  variant={authTab === 'password' ? 'primary' : 'secondary'}
                  onClick={() => setAuthTab('password')}
                  disabled={isEdit && !credentialsUnlocked}
                >
                  🔒 {t('ssh.form.authPassword')}
                </Button>
              </div>

              {isEdit && !credentialsUnlocked ? (
                <div className="rounded border border-gray-800 bg-gray-900/50 px-3 py-3 text-sm text-gray-400">
                  <div className="mb-2">{t('ssh.form.credentialsLocked')}</div>
                  <ConfirmButton
                    label={t('ssh.form.changeCredentials')}
                    confirmLabel={t('ssh.form.changeCredentialsConfirm')}
                    variant="danger"
                    confirmVariant="danger-solid"
                    size="sm"
                    onConfirm={() => setCredentialsUnlocked(true)}
                  />
                </div>
              ) : (
                <>
                  <div className="flex gap-1 mb-3">
                    <Button
                      size="xs"
                      variant={credMode === 'inline' ? 'edit' : 'secondary'}
                      onClick={() => setCredMode('inline')}
                    >
                      {t('ssh.form.credInline')}
                    </Button>
                    <Button
                      size="xs"
                      variant={credMode === 'pick' ? 'edit' : 'secondary'}
                      onClick={() => setCredMode('pick')}
                    >
                      {t('ssh.form.credPick')}
                    </Button>
                  </div>

                  {credMode === 'inline' && authTab === 'key' && (
                    <div className="space-y-2">
                      <FormTextarea
                        label={t('ssh.form.privateKey')}
                        required
                        rows={6}
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        className="font-mono text-xs"
                      />
                      <SecretInput
                        label={t('ssh.form.passphraseOptional')}
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        autoComplete="new-password"
                      />
                    </div>
                  )}

                  {credMode === 'inline' && authTab === 'password' && (
                    <SecretInput
                      label={t('ssh.form.password')}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  )}

                  {credMode === 'pick' && authTab === 'key' && (
                    <div className="space-y-2">
                      <FormSelect
                        label={t('ssh.form.pickKey')}
                        required
                        value={privateKeySecretId}
                        onChange={(e) => setPrivateKeySecretId(e.target.value)}
                        helpText={
                          keySecrets.length === 0
                            ? t('ssh.form.pickKeyEmpty')
                            : undefined
                        }
                      >
                        <option value="">—</option>
                        {keySecrets.map((s) => (
                          <option key={s._id} value={s._id}>
                            {s.key}
                            {s.description ? ` — ${s.description}` : ''}
                          </option>
                        ))}
                      </FormSelect>
                      <FormSelect
                        label={t('ssh.form.pickPassphraseOptional')}
                        value={passphraseSecretId}
                        onChange={(e) => setPassphraseSecretId(e.target.value)}
                      >
                        <option value="">—</option>
                        {passwordSecrets.map((s) => (
                          <option key={s._id} value={s._id}>
                            {s.key}
                            {s.description ? ` — ${s.description}` : ''}
                          </option>
                        ))}
                      </FormSelect>
                    </div>
                  )}

                  {credMode === 'pick' && authTab === 'password' && (
                    <FormSelect
                      label={t('ssh.form.pickPassword')}
                      required
                      value={passwordSecretId}
                      onChange={(e) => setPasswordSecretId(e.target.value)}
                      helpText={
                        passwordSecrets.length === 0
                          ? t('ssh.form.pickPasswordEmpty')
                          : undefined
                      }
                    >
                      <option value="">—</option>
                      {passwordSecrets.map((s) => (
                        <option key={s._id} value={s._id}>
                          {s.key}
                          {s.description ? ` — ${s.description}` : ''}
                        </option>
                      ))}
                    </FormSelect>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="border-t border-gray-800 px-5 py-3 flex flex-wrap justify-between gap-2">
            <div>
              {isEdit && (
                <ConfirmButton
                  label={t('common.delete')}
                  confirmLabel={t('common.confirmDelete')}
                  variant="danger"
                  confirmVariant="danger-solid"
                  size="sm"
                  onConfirm={handleDelete}
                />
              )}
            </div>
            <div className="flex gap-2">
              {isEdit && (
                <Button
                  variant="success"
                  size="sm"
                  disabled={testState.pending}
                  onClick={handleManualTest}
                >
                  {testState.pending ? '…' : t('ssh.form.test')}
                </Button>
              )}
              <Button variant="secondary" onClick={onClose} disabled={pending}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={submitDisabled}
                onClick={isEdit ? submitEdit : submitCreate}
              >
                {pending ? '…' : isEdit ? t('common.save') : t('common.create')}
              </Button>
            </div>
          </div>
        </Dialog>
      </Portal>

      {fpDialog && (
        <SshFingerprintDialog
          host={host}
          port={port}
          username={username}
          fingerprint={fpDialog.fingerprint}
          mismatch={fpDialog.mismatch}
          onAccept={handleAcceptFingerprint}
          onCancel={handleCancelFingerprint}
        />
      )}
    </>
  );
}
