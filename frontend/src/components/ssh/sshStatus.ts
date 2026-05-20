import {
  SshConnectionDetail,
  SshConnectionListItem,
  SshConnectionStatus,
} from '../../api/client';

/**
 * Client-side derivation per Spec §5.3 (so the UI stays self-consistent
 * even if the backend ever introduces a `status` field that lags behind the
 * raw fields below).
 *
 * Order matters:
 *   1. `key_missing` — auth=key without a privateKeySecretId ref. Only
 *      derivable from the detail-shape (list doesn't include refs).
 *   2. `fingerprint_pending` — no fingerprint accepted yet.
 *   3. `error` — `lastConnectError` populated.
 *   4. `ok` — `lastConnectedAt` set without a stale error.
 *   5. `never_tested` — fallback when nothing was ever attempted.
 */
export function deriveSshStatus(
  conn: SshConnectionListItem | SshConnectionDetail,
): SshConnectionStatus {
  const detail = conn as Partial<SshConnectionDetail>;
  if (conn.authMethod === 'key' && detail.privateKeySecretId !== undefined && !detail.privateKeySecretId) {
    // Detail-shape with explicit-null privateKeySecretId — defensive guard.
    return 'key_missing';
  }
  if (conn.lastConnectError) return 'error';
  if (!conn.knownHostFingerprintSet) {
    // No fingerprint yet — pending. If never connected, prefer the more
    // honest 'never_tested' label.
    return conn.lastConnectedAt ? 'fingerprint_pending' : 'never_tested';
  }
  if (conn.lastConnectedAt) return 'ok';
  return 'never_tested';
}

export interface SshStatusVisual {
  emoji: string;
  /** Static Tailwind class — no dynamic class-building (CLAUDE.md pitfall). */
  badgeClass: string;
  /** i18n key under `ssh.status.<id>`. */
  i18nKey: string;
}

export const SSH_STATUS_VISUAL: Record<SshConnectionStatus, SshStatusVisual> = {
  ok: {
    emoji: '✅',
    badgeClass: 'bg-green-900/50 text-green-300',
    i18nKey: 'ssh.status.ok',
  },
  never_tested: {
    emoji: '⚪',
    badgeClass: 'bg-gray-800 text-gray-400',
    i18nKey: 'ssh.status.never_tested',
  },
  error: {
    emoji: '❌',
    badgeClass: 'bg-red-900/50 text-red-300',
    i18nKey: 'ssh.status.error',
  },
  fingerprint_pending: {
    emoji: '🔒',
    badgeClass: 'bg-yellow-900/50 text-yellow-300',
    i18nKey: 'ssh.status.fingerprint_pending',
  },
  key_missing: {
    emoji: '⚠️',
    badgeClass: 'bg-amber-900/50 text-amber-300',
    i18nKey: 'ssh.status.key_missing',
  },
};
