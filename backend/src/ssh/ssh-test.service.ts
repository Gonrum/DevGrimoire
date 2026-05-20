import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Client as Ssh2Client } from 'ssh2';
import { SshService } from './ssh.service';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SshAudit,
  SshAuditDocument,
  SshAuditSourceContext,
} from './schemas/ssh-audit.schema';
import type { SshConnectionDocument } from './schemas/ssh-connection.schema';

export type SshTestErrorCode =
  | 'auth_failed'
  | 'host_unreachable'
  | 'host_key_mismatch'
  | 'credential_missing'
  | 'timeout'
  | 'unknown';

export interface SshTestResult {
  ok: boolean;
  fingerprint?: string;
  fingerprintAccepted?: boolean;
  fingerprintMismatch?: boolean;
  error?: {
    code: SshTestErrorCode;
    message: string;
  };
}

/**
 * Minimal injectable surface for `new ssh2.Client()`. The session service in
 * Schritt 3/8 will share this seam so unit tests can swap in fakes without
 * monkey-patching the `ssh2` module.
 */
export interface SshClientFactory {
  create(): Pick<
    Ssh2Client,
    'on' | 'connect' | 'end' | 'destroy'
  >;
}

const DEFAULT_FACTORY: SshClientFactory = {
  create: () => new Ssh2Client(),
};

const CONNECT_TIMEOUT_MS = 10_000;
// ssh2's internal readyTimeout fires SLIGHTLY before our outer setTimeout
// backstop so its own error event (with `code:'ETIMEDOUT'`/`ECONNREFUSED`)
// has a chance to be classified as `host_unreachable` rather than the
// generic outer-timeout `code:'timeout'` bucket.
const SSH2_READY_TIMEOUT_MS = CONNECT_TIMEOUT_MS - 500;

/**
 * SshTestService — REST `/test` probe.
 *
 * Single responsibility: resolve the connection's credentials, dial the
 * remote host, observe the host-key (TOFU), report success/failure as a
 * structured result, and write an audit entry. Does NOT keep clients alive
 * across calls. The full session lifecycle (exec/sftp) lives in the
 * upcoming SshSessionService (Schritt 3/8).
 *
 * Credentials are resolved in this class and never leave it. The audit
 * entry contains zero secret material.
 */
@Injectable()
export class SshTestService {
  private readonly logger = new Logger(SshTestService.name);

  constructor(
    private readonly sshService: SshService,
    private readonly secretsService: SecretsService,
    @InjectModel(SshAudit.name)
    private readonly auditModel: Model<SshAuditDocument>,
    private readonly notificationsService: NotificationsService,
    @Optional()
    private readonly clientFactory: SshClientFactory = DEFAULT_FACTORY,
  ) {}

  /**
   * Run a one-shot connect probe.
   *
   * Flow:
   *   1. Load connection + resolve credential secrets.
   *   2. Open ssh2.Client; in `hostVerifier`, compute the SHA-256 fingerprint
   *      and either confirm/reject based on `knownHostFingerprint`, or remember
   *      it as a "pending" fingerprint when none is stored yet.
   *   3. On 'ready' → record success, return ok=true.
   *   4. On 'error' / timeout → record error, return ok=false with a coded
   *      reason. The host-key path returns `ok=false` even on first-time
   *      success because the user still needs to accept the fingerprint via
   *      `/accept-fingerprint` before we count the connection as trusted.
   */
  async testConnection(
    connId: string,
    opts: { userId?: string; agentRoleId?: string } = {},
  ): Promise<SshTestResult> {
    const startedAt = Date.now();
    const sourceContext: SshAuditSourceContext = 'rest';

    let connection;
    try {
      connection = await this.sshService.findById(connId);
    } catch (err) {
      // Connection not found → bubble up (controller maps to 404). No audit
      // possible without a connectionId reference.
      throw err;
    }

    // Resolve credential material. Any miss → structured `credential_missing`.
    let creds: ResolvedCreds;
    try {
      creds = await this.resolveCredentials(connection);
    } catch (err) {
      const msg = (err as Error).message || 'credential_missing';
      await this.sshService.recordConnectError(connId, msg).catch(() => {});
      await this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        sourceContext,
        userId: opts.userId,
        agentRoleId: opts.agentRoleId,
        durationMs: Date.now() - startedAt,
        errorMsg: 'credential_missing',
      });
      return {
        ok: false,
        error: { code: 'credential_missing', message: msg },
      };
    }

    return new Promise<SshTestResult>((resolve) => {
      // Outer-scope flags captured by hostVerifier so 'ready'/'error' can see
      // them when they fire afterwards. ssh2 calls hostVerifier synchronously
      // BEFORE ready/error.
      let observedFingerprint: string | undefined;
      let fingerprintMismatch = false;
      let fingerprintAccepted = false;
      let firstTimeFingerprint = false;
      let settled = false;

      const client = this.clientFactory.create();

      const finalize = (result: SshTestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        // Defensive cleanup — end() is a no-op on never-opened sessions
        // (error/timeout paths), so we ALSO call destroy() to make sure the
        // underlying TCP socket gets released. Both throws are ignored:
        // ssh2 may have already errored and torn itself down.
        try {
          (client as Ssh2Client).end();
        } catch {
          /* ignore */
        }
        try {
          (client as Ssh2Client).destroy();
        } catch {
          /* ignore */
        }
        const durationMs = Date.now() - startedAt;

        // Persist status + audit. Both are best-effort; the user gets the
        // result regardless.
        const persist = async () => {
          if (result.ok) {
            await this.sshService.recordConnectSuccess(connId).catch(() => {});
          } else if (result.error) {
            await this.sshService
              .recordConnectError(connId, `${result.error.code}: ${result.error.message}`)
              .catch(() => {});
          } else {
            // Special case: first-time-fingerprint pending → not ok, but
            // also not a failure to "remember". Don't clobber lastConnect*
            // either way.
          }
          await this.writeAudit({
            connectionId: connection._id as Types.ObjectId,
            sourceContext,
            userId: opts.userId,
            agentRoleId: opts.agentRoleId,
            durationMs,
            errorMsg: result.error
              ? `${result.error.code}: ${result.error.message}`
              : undefined,
          });
          // Auth-failure push (Spec §6.6). Fire-and-forget; the user already
          // sees the error in the test-dialog and notifications are advisory.
          if (
            result.error?.code === 'auth_failed' &&
            connection.notifyOnAuthFailure
          ) {
            this.dispatchAuthFailureNotification(connection).catch((err) => {
              this.logger.warn(
                `Auth-failure notification failed for SshConnection ${connId}: ${(err as Error).message}`,
              );
            });
          }
        };
        persist().catch((err) => {
          this.logger.warn(
            `Audit persistence failed for SshConnection ${connId}: ${(err as Error).message}`,
          );
        });
        resolve(result);
      };

      const timeoutHandle = setTimeout(() => {
        finalize({
          ok: false,
          fingerprint: observedFingerprint,
          fingerprintMismatch: fingerprintMismatch || undefined,
          error: {
            code: 'timeout',
            message: `connect timeout after ${CONNECT_TIMEOUT_MS}ms`,
          },
        });
      }, CONNECT_TIMEOUT_MS);

      client.on('ready', () => {
        // Defense-in-depth: if a permissive ssh2 build ever emits `ready`
        // after the hostVerifier rejected (which the spec says it should
        // not — `error` is the real path, handled below), we still gate on
        // explicit fingerprint accept via /accept-fingerprint instead of
        // silently trusting the host.
        if (firstTimeFingerprint) {
          finalize({
            ok: false,
            fingerprint: observedFingerprint,
          });
          return;
        }
        finalize({
          ok: true,
          fingerprint: observedFingerprint,
          fingerprintAccepted: fingerprintAccepted || undefined,
        });
      });

      client.on('error', (err: Error & { level?: string }) => {
        // ssh2 emits 'error' (NOT 'ready') whenever hostVerifier returned
        // accept=false. We split the two cases the verifier set up:
        //   1) First-time host (no stored fingerprint yet) — return the
        //      observed fingerprint so the UI can show the accept dialog.
        //   2) Stored fingerprint mismatch — return host_key_mismatch.
        if (firstTimeFingerprint && observedFingerprint) {
          finalize({
            ok: false,
            fingerprint: observedFingerprint,
          });
          return;
        }
        if (fingerprintMismatch) {
          finalize({
            ok: false,
            fingerprint: observedFingerprint,
            fingerprintMismatch: true,
            error: {
              code: 'host_key_mismatch',
              message: 'remote host key differs from the stored fingerprint',
            },
          });
          return;
        }
        const classified = this.classifyConnectError(err);
        finalize({
          ok: false,
          fingerprint: observedFingerprint,
          error: classified,
        });
      });

      try {
        client.connect({
          host: connection.host,
          port: connection.port,
          username: connection.username,
          readyTimeout: SSH2_READY_TIMEOUT_MS,
          // Reject all but our explicit list. ssh2 also exposes hostHash so we
          // can request a SHA-256 hash from the lib — we still compute our own
          // canonical hex form below to keep the stored value in our control.
          hostHash: 'sha256',
          hostVerifier: (
            hashOrKey: Buffer | string,
            callback?: (accept: boolean) => void,
          ) => {
            // ssh2 calls this with either the hashed buffer (when hostHash is
            // set) or the raw key. We accept both code paths.
            const raw =
              typeof hashOrKey === 'string'
                ? Buffer.from(hashOrKey, 'binary')
                : hashOrKey;
            const fp = this.toCanonicalSha256(raw);
            observedFingerprint = fp;

            const known = connection.knownHostFingerprint;
            let accept: boolean;
            if (!known) {
              // First-time: we DO NOT accept silently. Frontend gates on
              // the explicit /accept-fingerprint call.
              firstTimeFingerprint = true;
              accept = false;
            } else if (known === fp) {
              fingerprintAccepted = true;
              accept = true;
            } else {
              fingerprintMismatch = true;
              accept = false;
            }
            if (callback) callback(accept);
            return accept;
          },
          // Auth credentials — never re-emitted from this point on.
          ...(connection.authMethod === 'key'
            ? {
                privateKey: creds.privateKey!,
                ...(creds.passphrase ? { passphrase: creds.passphrase } : {}),
              }
            : {
                password: creds.password!,
              }),
        });
      } catch (err) {
        // ssh2 throws synchronously on really broken inputs (bad key parse,
        // unsupported algorithm, …) before any event fires.
        finalize({
          ok: false,
          fingerprint: observedFingerprint,
          error: this.classifyConnectError(err as Error),
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveCredentials(connection: {
    authMethod: 'key' | 'password';
    privateKeySecretId?: Types.ObjectId;
    passphraseSecretId?: Types.ObjectId;
    passwordSecretId?: Types.ObjectId;
  }): Promise<ResolvedCreds> {
    if (connection.authMethod === 'key') {
      if (!connection.privateKeySecretId) {
        throw new Error('privateKeySecretId is not set');
      }
      const pk = await this.secretsService
        .findById(connection.privateKeySecretId.toString())
        .catch(() => {
          throw new Error('private key secret missing or inaccessible');
        });
      let passphrase: string | undefined;
      if (connection.passphraseSecretId) {
        const pp = await this.secretsService
          .findById(connection.passphraseSecretId.toString())
          .catch(() => {
            throw new Error('passphrase secret missing or inaccessible');
          });
        passphrase = pp.value;
      }
      return { privateKey: pk.value, passphrase };
    }
    if (!connection.passwordSecretId) {
      throw new Error('passwordSecretId is not set');
    }
    const pw = await this.secretsService
      .findById(connection.passwordSecretId.toString())
      .catch(() => {
        throw new Error('password secret missing or inaccessible');
      });
    return { password: pw.value };
  }

  /**
   * Canonicalize an ssh2 hash buffer to the same format we accept on the
   * /accept-fingerprint endpoint: 32 lowercase colon-separated hex bytes.
   * Falls back to recomputing SHA-256 when ssh2 fed us the raw key bytes.
   */
  private toCanonicalSha256(buf: Buffer): string {
    let bytes: Buffer;
    if (buf.length === 32) {
      // ssh2 already returned the hash (hostHash='sha256').
      bytes = buf;
    } else {
      // Compute SHA-256 over whatever ssh2 handed us.
      bytes = createHash('sha256').update(buf).digest();
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':');
  }

  /**
   * Map ssh2 errors onto the structured codes we return to the API.
   * We avoid leaking raw error stack traces; only the lib's brief message
   * goes back to the caller.
   */
  private classifyConnectError(err: Error & { level?: string; code?: string }): {
    code: SshTestErrorCode;
    message: string;
  } {
    const message = err?.message || 'unknown ssh error';
    const lvl = err?.level;
    const code = err?.code;

    if (
      lvl === 'client-authentication' ||
      /All configured authentication methods failed/i.test(message) ||
      /authentication/i.test(message)
    ) {
      return { code: 'auth_failed', message };
    }
    if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ETIMEDOUT' ||
      /unreachable|refused|not found|getaddrinfo/i.test(message)
    ) {
      return { code: 'host_unreachable', message };
    }
    if (/timed? ?out/i.test(message)) {
      return { code: 'timeout', message };
    }
    return { code: 'unknown', message };
  }

  /**
   * Dispatch a notification when an SSH connect failed with `auth_failed` and
   * the connection has `notifyOnAuthFailure` enabled (Spec §6.6). Reuses the
   * standard NotificationsService channel so the existing per-category
   * push-toggle in NotificationsSettings applies.
   *
   * Best-effort — the caller catches and logs but never fails the user flow.
   */
  private async dispatchAuthFailureNotification(
    connection: SshConnectionDocument,
  ): Promise<void> {
    const title = `SSH-Auth fehlgeschlagen: ${connection.label}`;
    const body = `Authentifizierung gegen ${connection.username}@${connection.host}:${connection.port} schlug fehl.`;
    await this.notificationsService.create(title, body, undefined, 'ssh_auth_failure');
  }

  private async writeAudit(entry: {
    connectionId: Types.ObjectId;
    sourceContext: SshAuditSourceContext;
    userId?: string;
    agentRoleId?: string;
    durationMs: number;
    errorMsg?: string;
  }): Promise<void> {
    // The audit schema requires userId. If the caller is the system (auth
    // disabled or unauthenticated path), userId is 'system' which isn't a
    // valid ObjectId — we skip the write to avoid littering invalid rows.
    if (!entry.userId || !Types.ObjectId.isValid(entry.userId)) {
      return;
    }
    await this.auditModel.create({
      connectionId: entry.connectionId,
      at: new Date(),
      action: 'connect',
      sourceContext: entry.sourceContext,
      userId: new Types.ObjectId(entry.userId),
      agentRoleId:
        entry.agentRoleId && Types.ObjectId.isValid(entry.agentRoleId)
          ? new Types.ObjectId(entry.agentRoleId)
          : undefined,
      durationMs: entry.durationMs,
      errorMsg: entry.errorMsg,
    });
  }
}

interface ResolvedCreds {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}
