import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Client as Ssh2Client,
  ClientChannel,
  SFTPWrapper,
  ConnectConfig,
} from 'ssh2';
import { SshService } from './ssh.service';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SshAudit,
  SshAuditAction,
  SshAuditDocument,
  SshAuditSourceContext,
} from './schemas/ssh-audit.schema';
import { SshConnectionDocument } from './schemas/ssh-connection.schema';

/**
 * Minimal injectable surface for `new ssh2.Client()`. Tests swap this for a
 * fake so we never touch the network and can drive `ready`/`error`/`exit`
 * events deterministically. Production uses `DEFAULT_FACTORY`.
 */
export interface SshClientFactory {
  create(): Ssh2Client;
}

const DEFAULT_FACTORY: SshClientFactory = {
  create: () => new Ssh2Client(),
};

// -------------------- Limits (per spec §6.4) --------------------
const KEEPALIVE_MS = 30_000;
const READY_TIMEOUT_MS = 9_500;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 64 * 1024;
const SIGKILL_GRACE_MS = 5_000;
const DEFAULT_DOWNLOAD_BYTES = 1_048_576; // 1 MB
const HARD_MAX_DOWNLOAD_BYTES = 10_485_760; // 10 MB
const SFTP_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (spec §6.4)
const DEFAULT_LIST_ENTRIES = 200;
const HARD_MAX_LIST_ENTRIES = 2000;
const LIST_RECURSE_MAX_DEPTH = 10;
const CONCURRENCY_LIMIT = 5;
const CONCURRENCY_WAIT_MS = 30_000;
const AUDIT_COMMAND_TRUNC = 500;

export type SshSessionSourceContext = 'mcp' | 'rest' | 'terminal';

export interface SshExecOpts {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  sourceContext?: SshSessionSourceContext;
  userId?: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface SshUploadOpts {
  mode?: number;
  createDirs?: boolean;
  sourceContext?: Exclude<SshSessionSourceContext, 'terminal'>;
  userId?: string;
}

export interface SshUploadResult {
  bytesWritten: number;
  remotePath: string;
}

export interface SshDownloadOpts {
  maxBytes?: number;
  sourceContext?: Exclude<SshSessionSourceContext, 'terminal'>;
  userId?: string;
}

export interface SshDownloadResult {
  content: Buffer;
  bytesRead: number;
  truncated: boolean;
}

export interface SshListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
  mtime: Date;
}

export interface SshListResult {
  entries: SshListEntry[];
  truncated: boolean;
}

export interface SshListOpts {
  recursive?: boolean;
  maxEntries?: number;
  sourceContext?: Exclude<SshSessionSourceContext, 'terminal'>;
  userId?: string;
}

interface ResolvedCreds {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

interface PendingSlot {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ConcurrencyState {
  active: number;
  queue: PendingSlot[];
}

/**
 * Centralised SSH operation pump.
 *
 * Lifecycle per spec §4.4:
 *   - One ssh2.Client per operation (no pool).
 *   - TOFU in hostVerifier — first-time unaccepted hosts and mismatches throw
 *     before auth, so we never leak credentials onto a wrong wire.
 *   - Resolved credential values stay inside this class; audit logs only
 *     reference IDs and truncated command strings.
 *   - Per-connection semaphore caps 5 concurrent ops with a 30s queue wait.
 *
 * Consumed by:
 *   - MCP tools (Schritt 6/8) — exec/upload/download/listFiles.
 *   - WS terminal route in main.ts (this PR) — connect()+client.shell().
 *
 * NOT consumed by SshTestService — that one keeps its own connect path
 * because the TOFU-first-time-pending result is a structured "not ok"
 * outcome, not a thrown error.
 */
@Injectable()
export class SshSessionService {
  private readonly logger = new Logger(SshSessionService.name);
  private readonly concurrency = new Map<string, ConcurrencyState>();

  constructor(
    private readonly sshService: SshService,
    private readonly secretsService: SecretsService,
    @InjectModel(SshAudit.name)
    private readonly auditModel: Model<SshAuditDocument>,
    private readonly notificationsService: NotificationsService,
    private readonly clientFactory: SshClientFactory = DEFAULT_FACTORY,
  ) {}

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Opens a long-lived ssh2 client for the caller (typically the WS terminal
   * handler). The CALLER owns the lifecycle from here on — must call
   * `client.end()` and `client.destroy()` when done. Used by the WS terminal
   * route which keeps the client alive for the session duration.
   *
   * NOTE: Bypasses the concurrency-semaphore by design (Spec §6.4: terminal
   * sessions are user-driven and have no per-connection limit). For one-shot
   * operations (exec/sftpUpload/sftpDownload/listFiles) use the higher-level
   * methods on this service which respect the semaphore.
   *
   * The `ptyCols`/`ptyRows` opts are accepted for API symmetry with callers
   * that pass them through — actual PTY allocation happens at `client.shell()`
   * time on the returned client.
   *
   * Throws `'tofu_not_accepted'` when knownHostFingerprint is unset,
   * `'host_key_mismatch'` on fingerprint divergence, `'credential_missing'`
   * when referenced secrets are gone.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(
    connId: string,
    _opts: { ptyCols?: number; ptyRows?: number } = {},
  ): Promise<Ssh2Client> {
    const connection = await this.sshService.findById(connId);
    let creds: ResolvedCreds;
    try {
      creds = await this.resolveCredentials(connection);
    } catch (err) {
      await this.recordError(connId, 'credential_missing', err as Error);
      throw new Error('credential_missing');
    }
    return this.openClient(connection, creds);
  }

  /**
   * Run a single command. Wraps in a per-connection semaphore so we don't
   * inadvertently melt the remote with N parallel forks.
   */
  async exec(
    connId: string,
    command: string,
    opts: SshExecOpts = {},
  ): Promise<SshExecResult> {
    const startedAt = Date.now();
    const sourceContext = opts.sourceContext ?? 'mcp';
    await this.acquireSlot(connId);
    let client: Ssh2Client | null = null;
    try {
      const connection = await this.sshService.findById(connId);
      let creds: ResolvedCreds;
      try {
        creds = await this.resolveCredentials(connection);
      } catch (err) {
        await this.recordError(connId, 'credential_missing', err as Error);
        void this.writeAudit({
          connectionId: connection._id as Types.ObjectId,
          action: 'exec',
          sourceContext,
          userId: opts.userId,
          command: this.truncateCommand(command),
          durationMs: Date.now() - startedAt,
          errorMsg: 'credential_missing',
        });
        throw new Error('credential_missing');
      }

      client = await this.openClient(connection, creds);
      const wrappedCommand = opts.cwd
        ? `cd '${this.shellSingleQuoteEscape(opts.cwd)}' && ${command}`
        : command;
      const timeoutMs = Math.min(
        Math.max(1, opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
        MAX_EXEC_TIMEOUT_MS,
      );

      const inner = await this.runExec(client, wrappedCommand, opts.env, timeoutMs);
      const durationMs = Date.now() - startedAt;

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'exec',
        sourceContext,
        userId: opts.userId,
        command: this.truncateCommand(command),
        exitCode: inner.exitCode ?? undefined,
        durationMs,
      });

      return { ...inner, durationMs };
    } finally {
      if (client) {
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
      }
      this.releaseSlot(connId);
    }
  }

  async sftpUpload(
    connId: string,
    remotePath: string,
    content: Buffer,
    opts: SshUploadOpts = {},
  ): Promise<SshUploadResult> {
    const startedAt = Date.now();
    const sourceContext = opts.sourceContext ?? 'mcp';
    await this.acquireSlot(connId);
    // Hard size cap per spec §6.4. Guard inside the slot so the release in
    // finally still runs, but before we open any network resources.
    if (content.length > SFTP_MAX_UPLOAD_BYTES) {
      this.releaseSlot(connId);
      throw new Error(
        `upload_too_large: ${content.length} > ${SFTP_MAX_UPLOAD_BYTES}`,
      );
    }
    let client: Ssh2Client | null = null;
    try {
      const connection = await this.sshService.findById(connId);
      const creds = await this.resolveCredentialsOrFail(connection);
      client = await this.openClient(connection, creds);
      const sftp = await this.openSftp(client);

      if (opts.createDirs) {
        await this.ensureParentDirs(sftp, remotePath);
      }

      const result = await this.runSftpWrite(
        sftp,
        remotePath,
        content,
        opts.mode ?? 0o644,
      );

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'upload',
        sourceContext,
        userId: opts.userId,
        remotePath,
        bytes: result.bytesWritten,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } finally {
      if (client) {
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
      }
      this.releaseSlot(connId);
    }
  }

  async sftpDownload(
    connId: string,
    remotePath: string,
    opts: SshDownloadOpts = {},
  ): Promise<SshDownloadResult> {
    const startedAt = Date.now();
    const sourceContext = opts.sourceContext ?? 'mcp';
    const maxBytes = Math.min(
      Math.max(1, opts.maxBytes ?? DEFAULT_DOWNLOAD_BYTES),
      HARD_MAX_DOWNLOAD_BYTES,
    );
    await this.acquireSlot(connId);
    let client: Ssh2Client | null = null;
    try {
      const connection = await this.sshService.findById(connId);
      const creds = await this.resolveCredentialsOrFail(connection);
      client = await this.openClient(connection, creds);
      const sftp = await this.openSftp(client);
      const result = await this.runSftpRead(sftp, remotePath, maxBytes);

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'download',
        sourceContext,
        userId: opts.userId,
        remotePath,
        bytes: result.bytesRead,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } finally {
      if (client) {
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
      }
      this.releaseSlot(connId);
    }
  }

  async listFiles(
    connId: string,
    remotePath: string,
    opts: SshListOpts = {},
  ): Promise<SshListResult> {
    const startedAt = Date.now();
    const sourceContext = opts.sourceContext ?? 'mcp';
    const maxEntries = Math.min(
      Math.max(1, opts.maxEntries ?? DEFAULT_LIST_ENTRIES),
      HARD_MAX_LIST_ENTRIES,
    );
    await this.acquireSlot(connId);
    let client: Ssh2Client | null = null;
    try {
      const connection = await this.sshService.findById(connId);
      const creds = await this.resolveCredentialsOrFail(connection);
      client = await this.openClient(connection, creds);
      const sftp = await this.openSftp(client);
      const result = await this.runListFiles(
        sftp,
        remotePath,
        maxEntries,
        !!opts.recursive,
      );

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'list_files',
        sourceContext,
        userId: opts.userId,
        remotePath,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } finally {
      if (client) {
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
      }
      this.releaseSlot(connId);
    }
  }

  // ===========================================================================
  // Audit (best-effort, fire-and-forget)
  // ===========================================================================
  //
  // Audit writes are intentionally non-blocking: a failed insert MUST NEVER
  // tear down a successful SSH op (the user already got the byte stream, we
  // can't un-deliver it). A logger.warn surfaces the issue to ops.
  /**
   * Best-effort audit row insert. Returns the awaitable Promise so the WS
   * terminal route can sequence `terminal_close` against the closing exit
   * code; the in-process exec/sftp paths just fire-and-forget it.
   */
  writeAudit(entry: {
    connectionId: Types.ObjectId;
    action: SshAuditAction;
    sourceContext: SshAuditSourceContext;
    userId?: string;
    agentRoleId?: string;
    command?: string;
    remotePath?: string;
    bytes?: number;
    exitCode?: number;
    durationMs?: number;
    errorMsg?: string;
  }): Promise<void> {
    // Same guard as SshTestService: 'system' (or any non-ObjectId userId)
    // would blow up Mongoose's required-ObjectId validation on userId.
    // We log at debug so silent drops are visible in dev/ops but don't
    // pollute prod logs (most legitimate non-ObjectId paths are 'system'
    // and internal callers without a user context).
    if (!entry.userId || !Types.ObjectId.isValid(entry.userId)) {
      this.logger.debug(
        `Audit-Write übersprungen: userId='${entry.userId ?? 'undefined'}' ist kein ObjectId (action=${entry.action}, sourceContext=${entry.sourceContext})`,
      );
      return Promise.resolve();
    }
    const doc: Record<string, unknown> = {
      connectionId: entry.connectionId,
      at: new Date(),
      action: entry.action,
      sourceContext: entry.sourceContext,
      userId: new Types.ObjectId(entry.userId),
      durationMs: entry.durationMs,
    };
    if (entry.agentRoleId && Types.ObjectId.isValid(entry.agentRoleId)) {
      doc.agentRoleId = new Types.ObjectId(entry.agentRoleId);
    }
    if (entry.command !== undefined) doc.command = entry.command;
    if (entry.remotePath !== undefined) doc.remotePath = entry.remotePath;
    if (entry.bytes !== undefined) doc.bytes = entry.bytes;
    if (entry.exitCode !== undefined) doc.exitCode = entry.exitCode;
    if (entry.errorMsg !== undefined) doc.errorMsg = entry.errorMsg;

    return Promise.resolve(this.auditModel.create(doc))
      .then(() => undefined)
      .catch((err: Error) => {
        this.logger.warn(
          `Audit persistence failed for SshConnection ${entry.connectionId}: ${err.message}`,
        );
      });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Open an ssh2.Client and wait for `ready`. TOFU verifier runs first; on
   * unaccepted / mismatch we settle with the precise structured error
   * BEFORE the auth phase, so credentials never hit a wrong host.
   */
  private openClient(
    connection: SshConnectionDocument,
    creds: ResolvedCreds,
  ): Promise<Ssh2Client> {
    return new Promise<Ssh2Client>((resolve, reject) => {
      const client = this.clientFactory.create();
      let settled = false;
      let verifierError: Error | null = null;

      const finishWithError = (err: Error) => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
        // Best-effort connection-status update; never await so a slow Mongo
        // doesn't pin the failure surface.
        this.sshService
          .recordConnectError(
            (connection._id as Types.ObjectId).toString(),
            err.message,
          )
          .catch(() => { /* noop */ });
        // Auth-failure push (Spec §6.6). The SSH-Session path classifies the
        // error code from the ssh2 error.level/message here so the
        // recordConnectError stamp and the notification dispatch agree on
        // whether this was an auth failure.
        if (
          connection.notifyOnAuthFailure &&
          this.isAuthFailure(err)
        ) {
          this.dispatchAuthFailureNotification(connection).catch((nerr) => {
            this.logger.warn(
              `Auth-failure notification failed for SshConnection ${(connection._id as Types.ObjectId).toString()}: ${(nerr as Error).message}`,
            );
          });
        }
        reject(err);
      };

      client.on('ready', () => {
        if (settled) return;
        if (verifierError) {
          // Defense-in-depth: hostVerifier rejected but some ssh2 build
          // still emitted 'ready'. Gate explicitly.
          finishWithError(verifierError);
          return;
        }
        settled = true;
        this.sshService
          .recordConnectSuccess((connection._id as Types.ObjectId).toString())
          .catch(() => { /* noop */ });
        resolve(client);
      });

      client.on('error', (err: Error) => {
        if (verifierError) {
          finishWithError(verifierError);
          return;
        }
        finishWithError(err);
      });

      const config: ConnectConfig = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_MS,
        hostHash: 'sha256',
        hostVerifier: (
          hashOrKey: Buffer | string,
          callback?: (accept: boolean) => void,
        ) => {
          const raw =
            typeof hashOrKey === 'string'
              ? Buffer.from(hashOrKey, 'binary')
              : hashOrKey;
          const fp = this.toCanonicalSha256(raw);
          const known = connection.knownHostFingerprint;
          let accept: boolean;
          if (!known) {
            verifierError = new Error('tofu_not_accepted');
            accept = false;
          } else if (known === fp) {
            accept = true;
          } else {
            verifierError = new Error('host_key_mismatch');
            accept = false;
          }
          if (callback) callback(accept);
          return accept;
        },
      };

      const authPatch: Record<string, unknown> = {};
      if (connection.authMethod === 'key') {
        authPatch.privateKey = creds.privateKey!;
        if (creds.passphrase) authPatch.passphrase = creds.passphrase;
      } else {
        authPatch.password = creds.password!;
      }

      try {
        client.connect({ ...config, ...authPatch } as ConnectConfig);
      } catch (err) {
        finishWithError(err as Error);
      }
    });
  }

  /**
   * Run an `exec` against an already-ready client. Caller owns the client
   * lifecycle. Handles stdout/stderr truncation and the SIGTERM→SIGKILL
   * escalation on timeout.
   */
  private runExec(
    client: Ssh2Client,
    command: string,
    env: Record<string, string> | undefined,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: string;
    truncated: { stdout: boolean; stderr: boolean };
  }> {
    return new Promise((resolve, reject) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let exitCode: number | null = null;
      let signal: string | undefined;
      let channel: ClientChannel | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const finalize = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killTimer) clearTimeout(killTimer);
        let stdout = Buffer.concat(stdoutChunks).toString('utf8');
        let stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (stdoutTruncated) {
          const more = Math.max(0, stdoutBytes - STDOUT_LIMIT);
          stdout += `\n[truncated: ${more} bytes more]`;
        }
        if (stderrTruncated) {
          const more = Math.max(0, stderrBytes - STDERR_LIMIT);
          stderr += `\n[truncated: ${more} bytes more]`;
        }
        resolve({
          stdout,
          stderr,
          exitCode,
          signal,
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        });
      };

      const execOpts = env ? { env } : {};
      try {
        client.exec(command, execOpts, (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            if (settled) return;
            settled = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (killTimer) clearTimeout(killTimer);
            reject(err);
            return;
          }
          channel = stream;

          stream.on('data', (chunk: Buffer) => {
            if (stdoutBytes >= STDOUT_LIMIT) {
              stdoutBytes += chunk.length;
              stdoutTruncated = true;
              return;
            }
            if (stdoutBytes + chunk.length <= STDOUT_LIMIT) {
              stdoutChunks.push(chunk);
              stdoutBytes += chunk.length;
              return;
            }
            const space = STDOUT_LIMIT - stdoutBytes;
            if (space > 0) stdoutChunks.push(chunk.subarray(0, space));
            stdoutBytes += chunk.length;
            stdoutTruncated = true;
          });

          stream.stderr.on('data', (chunk: Buffer) => {
            if (stderrBytes >= STDERR_LIMIT) {
              stderrBytes += chunk.length;
              stderrTruncated = true;
              return;
            }
            if (stderrBytes + chunk.length <= STDERR_LIMIT) {
              stderrChunks.push(chunk);
              stderrBytes += chunk.length;
              return;
            }
            const space = STDERR_LIMIT - stderrBytes;
            if (space > 0) stderrChunks.push(chunk.subarray(0, space));
            stderrBytes += chunk.length;
            stderrTruncated = true;
          });

          // ssh2 emits 'exit' as (code) for normal exit or (null, signal,
          // dump, desc) for signal-induced. 'close' fires after streams
          // flushed — finalize there so output buffers are complete.
          stream.on('exit', (code: number | null, sig?: string) => {
            exitCode = code;
            if (sig) signal = sig;
          });
          stream.on('close', () => {
            finalize();
          });
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err as Error);
        return;
      }

      timeoutHandle = setTimeout(() => {
        if (settled) return;
        // SIGTERM, then SIGKILL after the grace window.
        signal = signal ?? 'SIGTERM';
        if (channel) {
          try { channel.signal('TERM'); } catch { /* noop */ }
        }
        killTimer = setTimeout(() => {
          if (settled) return;
          signal = 'SIGKILL';
          if (channel) {
            try { channel.signal('KILL'); } catch { /* noop */ }
            try { channel.close(); } catch { /* noop */ }
          }
          // If the channel never emits 'close' (e.g. fake ssh2 in tests),
          // settle here so the caller doesn't hang.
          finalize();
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);
    });
  }

  private runSftpWrite(
    sftp: SFTPWrapper,
    remotePath: string,
    content: Buffer,
    mode: number,
  ): Promise<SshUploadResult> {
    return new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath, { mode });
      let bytesWritten = 0;
      let settled = false;
      ws.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      ws.on('close', () => {
        if (settled) return;
        settled = true;
        resolve({ bytesWritten, remotePath });
      });
      ws.write(content, (err?: Error | null) => {
        if (err) {
          if (settled) return;
          settled = true;
          reject(err);
          return;
        }
        bytesWritten = content.length;
        ws.end();
      });
    });
  }

  private runSftpRead(
    sftp: SFTPWrapper,
    remotePath: string,
    maxBytes: number,
  ): Promise<SshDownloadResult> {
    return new Promise((resolve, reject) => {
      const rs = sftp.createReadStream(remotePath);
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        resolve({
          content: Buffer.concat(chunks),
          bytesRead: total,
          truncated,
        });
      };
      rs.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          truncated = true;
          try { (rs as unknown as { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
          finalize();
          return;
        }
        if (chunk.length <= remaining) {
          chunks.push(chunk);
          total += chunk.length;
        } else {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          truncated = true;
          try { (rs as unknown as { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
          finalize();
        }
      });
      rs.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      rs.on('close', () => finalize());
      rs.on('end', () => finalize());
    });
  }

  private async runListFiles(
    sftp: SFTPWrapper,
    remotePath: string,
    maxEntries: number,
    recursive: boolean,
  ): Promise<SshListResult> {
    const out: SshListEntry[] = [];
    let truncated = false;

    const readOne = (p: string): Promise<Array<{ filename: string; attrs: import('ssh2').Stats }>> =>
      new Promise((resolve, reject) => {
        sftp.readdir(p, (err, list) => {
          if (err) reject(err);
          else resolve(list);
        });
      });

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (depth > LIST_RECURSE_MAX_DEPTH) return;
      const list = await readOne(dir);
      for (const item of list) {
        if (out.length >= maxEntries) {
          truncated = true;
          return;
        }
        const fullPath =
          dir.endsWith('/') ? dir + item.filename : `${dir}/${item.filename}`;
        const type = this.classifyEntry(item.attrs);
        out.push({
          name: item.filename,
          path: fullPath,
          type,
          size: item.attrs.size,
          mode: item.attrs.mode,
          mtime: new Date(item.attrs.mtime * 1000),
        });
        if (recursive && type === 'dir') {
          await walk(fullPath, depth + 1);
          if (out.length >= maxEntries) {
            truncated = true;
            return;
          }
        }
      }
    };

    await walk(remotePath, 0);
    return { entries: out, truncated };
  }

  private classifyEntry(attrs: import('ssh2').Stats): 'file' | 'dir' | 'symlink' {
    try {
      if (attrs.isDirectory && attrs.isDirectory()) return 'dir';
      if (attrs.isSymbolicLink && attrs.isSymbolicLink()) return 'symlink';
    } catch { /* fake attrs may lack methods */ }
    // Fall back to POSIX S_IFMT bits.
    const mode = (attrs.mode ?? 0) & 0o170000;
    if (mode === 0o040000) return 'dir';
    if (mode === 0o120000) return 'symlink';
    return 'file';
  }

  private openSftp(client: Ssh2Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  /**
   * ssh2's mkdir is single-level. Walk the parents and `mkdir` each one,
   * swallowing "already exists" errors so partial creates are idempotent.
   */
  private async ensureParentDirs(
    sftp: SFTPWrapper,
    remotePath: string,
  ): Promise<void> {
    const parent = this.dirname(remotePath);
    if (!parent || parent === '/' || parent === '.') return;
    const parts = parent.split('/').filter(Boolean);
    let acc = parent.startsWith('/') ? '' : '.';
    for (const p of parts) {
      acc = acc === '' ? `/${p}` : `${acc}/${p}`;
      await new Promise<void>((resolve) => {
        sftp.mkdir(acc, (err?: Error & { code?: number }) => {
          // Most SSH servers return SSH_FX_FAILURE (code=4) for an already
          // existing path; some return SSH_FX_FILE_ALREADY_EXISTS (code=11).
          // Swallow either: subsequent operations will surface real errors.
          if (err && typeof this.logger.debug === 'function') {
            this.logger.debug(`mkdir ${acc} returned (ignored): ${err.message}`);
          }
          resolve();
        });
      });
    }
  }

  private dirname(p: string): string {
    if (!p) return '';
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx);
  }

  // -------------------- Credential resolution --------------------

  /**
   * Resolve secrets. Plaintext stays in the returned object and never leaves
   * this service. Throws a precise message so callers can map to the
   * `credential_missing` channel without leaking what was missing.
   */
  private async resolveCredentials(connection: SshConnectionDocument): Promise<ResolvedCreds> {
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
   * SFTP entry-point wrapper: translate any resolution failure to the
   * canonical 'credential_missing' string and stamp it on the connection.
   * exec() does its own write because it also needs an audit row.
   */
  private async resolveCredentialsOrFail(connection: SshConnectionDocument): Promise<ResolvedCreds> {
    try {
      return await this.resolveCredentials(connection);
    } catch (err) {
      await this.recordError(
        (connection._id as Types.ObjectId).toString(),
        'credential_missing',
        err as Error,
      );
      throw new Error('credential_missing');
    }
  }

  /**
   * Detect ssh2 auth failures by inspecting both the `level` field (set on
   * structured ssh2 errors) and the message. Mirrors the classifier in
   * `SshTestService.classifyConnectError` so notify-eligibility is consistent
   * across the test-probe and the session-pump entry points.
   */
  private isAuthFailure(err: Error & { level?: string; code?: string }): boolean {
    const message = err?.message || '';
    const level = err?.level;
    if (level === 'client-authentication') return true;
    if (/All configured authentication methods failed/i.test(message)) return true;
    if (/authentication/i.test(message)) return true;
    if (message === 'auth_failed' || message.startsWith('auth_failed:')) return true;
    return false;
  }

  /**
   * Dispatch a notification when an SSH connect failed with `auth_failed` and
   * the connection has `notifyOnAuthFailure` enabled (Spec §6.6). Mirrors the
   * counterpart in SshTestService so both connect paths feed the same
   * `ssh_auth_failure` push category.
   */
  private async dispatchAuthFailureNotification(
    connection: SshConnectionDocument,
  ): Promise<void> {
    const title = `SSH-Auth fehlgeschlagen: ${connection.label}`;
    const body = `Authentifizierung gegen ${connection.username}@${connection.host}:${connection.port} schlug fehl.`;
    await this.notificationsService.create(title, body, undefined, 'ssh_auth_failure');
  }

  private async recordError(connId: string, code: string, err: Error): Promise<void> {
    try {
      await this.sshService.recordConnectError(connId, `${code}: ${err.message}`);
    } catch {
      /* swallow — status persistence is best-effort */
    }
  }

  private toCanonicalSha256(buf: Buffer): string {
    let bytes: Buffer;
    if (buf.length === 32) {
      bytes = buf;
    } else {
      bytes = createHash('sha256').update(buf).digest();
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':');
  }

  /**
   * Escape a string for safe inclusion inside POSIX single-quotes. A literal
   * single-quote can't appear inside a single-quoted string, so we close the
   * quote, emit an escaped quote, then re-open — `'` becomes `'\''`.
   */
  private shellSingleQuoteEscape(s: string): string {
    return s.replace(/'/g, `'\\''`);
  }

  private truncateCommand(cmd: string): string {
    if (cmd.length <= AUDIT_COMMAND_TRUNC) return cmd;
    return cmd.slice(0, AUDIT_COMMAND_TRUNC);
  }

  // -------------------- Concurrency semaphore --------------------
  //
  // Per spec §6.4: max 5 parallel ops per connectionId; arrivals queue up
  // and time out after 30s with the structured 'concurrency_limit_exceeded'
  // error. Pure in-process — no NPM dep, no shared state across nodes
  // (consistent with the rest of DevGrimoire's single-node assumptions).

  private async acquireSlot(connId: string): Promise<void> {
    const state = this.getState(connId);
    if (state.active < CONCURRENCY_LIMIT) {
      state.active += 1;
      return;
    }
    // Slow path: queue + wait. NOTE: when the waiter resolves we do NOT
    // bump `active` again — the releaser hands off its slot to us via the
    // slot-transfer pattern in `releaseSlot` (it skips the `-=1` when a
    // waiter is present). Without this transfer a third acquireSlot could
    // race in via the fast-path between releaser's `-=1` and waiter's
    // `+=1`, breaking the LIMIT.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the queue if we're still in it.
        const idx = state.queue.findIndex((p) => p.timer === timer);
        if (idx >= 0) state.queue.splice(idx, 1);
        reject(new Error('concurrency_limit_exceeded'));
      }, CONCURRENCY_WAIT_MS);
      state.queue.push({ resolve, reject, timer });
    });
  }

  private releaseSlot(connId: string): void {
    const state = this.getState(connId);
    const next = state.queue.shift();
    if (next) {
      // Slot transfer: the slot stays "active" but the owner changes from
      // the releaser to the waiter. We MUST NOT decrement active here —
      // otherwise active < LIMIT briefly, and a fresh acquireSlot caller
      // could fast-path past the semaphore (#C1 race).
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    state.active = Math.max(0, state.active - 1);
    if (state.active === 0) {
      this.concurrency.delete(connId);
    }
  }

  private getState(connId: string): ConcurrencyState {
    let s = this.concurrency.get(connId);
    if (!s) {
      s = { active: 0, queue: [] };
      this.concurrency.set(connId, s);
    }
    return s;
  }
}
