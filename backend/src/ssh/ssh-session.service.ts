import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
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
// Default "no-output" watchdog: if the remote command produces no stdout or
// stderr bytes for this long, abort with the same SIGTERM→SIGKILL escalation
// as the absolute timeoutMs. Catches the case where the SSH channel is alive
// but the remote command silently went away (T-387: 1-hour silent hang on
// plugin:install). Callers can override or disable with idleTimeoutMs=0.
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
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
// Async exec job table (T-388). Tail buffers keep the *last N bytes* of each
// stream so a polling agent can see recent output without us holding the full
// 256 KB stdout buffer per running job. Job state lingers for JOB_TTL_MS after
// terminal state so the agent can poll the final result a few times before
// the entry is reaped.
const TAIL_STDOUT_BYTES = 4 * 1024;
const TAIL_STDERR_BYTES = 2 * 1024;
const JOB_TTL_MS = 10 * 60_000;

export type SshSessionSourceContext = 'mcp' | 'rest' | 'terminal';

export interface SshExecOpts {
  timeoutMs?: number;
  /**
   * No-output watchdog (T-387). Abort the command after this many ms have
   * passed without ANY stdout/stderr bytes — independent from the absolute
   * `timeoutMs`. Default 30 000 ms. Pass `0` to disable the watchdog (legacy
   * behaviour for commands that legitimately stay silent for long stretches,
   * e.g. `sleep 600 && echo done`). Clamped to `[0, timeoutMs]` because a
   * larger idle window than the absolute timeout would be redundant.
   */
  idleTimeoutMs?: number;
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
  /** Total bytes received (BEFORE truncation cap, useful for progress UI). */
  stdoutBytes: number;
  stderrBytes: number;
  /**
   * Milliseconds between the last stdout/stderr chunk and `close`. `0` when
   * the command produced no output at all. Lets callers distinguish "ran
   * cleanly" from "channel went silent before exit".
   */
  lastChunkAgeMs: number;
  /**
   * Reason finalize() ran via an escalation timer rather than the remote's
   * own `close`. `undefined` for the happy path. `cancelled` is only set via
   * the async-exec cancel hook (T-388).
   */
  aborted?: 'timeout' | 'idle' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Async exec (T-388) — job-table types
// ---------------------------------------------------------------------------

export type SshExecJobState = 'running' | 'done' | 'aborted';

/**
 * Snapshot of an async exec job, returned by `getJobStatus()` / the
 * `ssh_exec_status` MCP tool. While the job is `running` only the live
 * progress fields are populated; terminal-state fields (`exitCode`, `signal`,
 * `aborted`, `durationMs`, `truncated`) get filled when the job finalises.
 *
 * Tail snippets are utf-8 strings rendered from the rolling byte tail.
 * Invalid byte sequences are passed through as the U+FFFD replacement
 * character — terminal stdout is overwhelmingly text, and a polling agent
 * should not have to deal with a base64 round-trip just to peek at progress.
 * Binary payloads should be downloaded with `ssh_download` instead.
 */
export interface SshExecJobStatus {
  jobId: string;
  connectionId: string;
  command: string;
  startedAt: string; // ISO timestamp
  state: SshExecJobState;
  elapsedMs: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  lastChunkAgeMs: number;
  exitCode: number | null;
  signal: string | null;
  aborted: 'timeout' | 'idle' | 'cancelled' | null;
  errorMsg: string | null;
  truncated: { stdout: boolean; stderr: boolean } | null;
  durationMs: number | null;
}

/**
 * Internal job-table entry. Mutated in place by the running runExec hooks
 * (`onStdout`/`onStderr`) and by finalize-stamping in `runExecForJob`. Kept
 * private to the service; external callers only ever see `SshExecJobStatus`
 * snapshots produced by `serialiseJob()`.
 */
interface ExecJob {
  jobId: string;
  connectionId: string;
  command: string;          // user-facing command (unwrapped, truncated for audit)
  wrappedCommand: string;   // actual command sent to remote (with cwd prefix)
  startedAt: number;        // epoch ms
  sourceContext: SshSessionSourceContext;
  userId?: string;
  // Live progress (mutates while running)
  state: SshExecJobState;
  stdoutBytes: number;
  stderrBytes: number;
  lastChunkAt: number | null;
  stdoutTail: Buffer[];
  stdoutTailBytes: number;
  stderrTail: Buffer[];
  stderrTailBytes: number;
  // Terminal state (filled on finalize)
  exitCode: number | null;
  signal?: string;
  aborted?: 'timeout' | 'idle' | 'cancelled';
  errorMsg?: string;
  truncated?: { stdout: boolean; stderr: boolean };
  durationMs?: number;
  // Bookkeeping
  ttlTimer?: NodeJS.Timeout;
  cancel?: () => void; // populated once runExec is wired up; calls escalate('cancelled')
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
  // Async-exec job table (T-388). Keyed by jobId; entries linger for
  // JOB_TTL_MS after finalize so polling agents get a chance to read the
  // terminal state before garbage collection. NOT persisted — a backend
  // restart drops in-flight jobs; the audit row written at finalize is the
  // durable record.
  private readonly execJobs = new Map<string, ExecJob>();

  constructor(
    private readonly sshService: SshService,
    private readonly secretsService: SecretsService,
    @InjectModel(SshAudit.name)
    private readonly auditModel: Model<SshAuditDocument>,
    private readonly notificationsService: NotificationsService,
    @Optional()
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
      // Idle watchdog: derive from caller input, clamp to [0, timeoutMs].
      // 0 disables the watchdog entirely (legacy behaviour for long-quiet
      // commands). When `idleTimeoutMs` is omitted we default to 30s but
      // never larger than the absolute timeout.
      const rawIdle = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const idleTimeoutMs =
        rawIdle <= 0 ? 0 : Math.min(Math.max(1, rawIdle), timeoutMs);

      const inner = await this.runExec(
        client,
        wrappedCommand,
        opts.env,
        timeoutMs,
        idleTimeoutMs,
      );
      const durationMs = Date.now() - startedAt;

      // Surface aborts in the audit row so ops can spot stalled connections.
      // errorMsg piggybacks on the existing field; the new SshExecResult
      // `aborted` flag is the canonical signal for callers.
      const auditErrorMsg = inner.aborted
        ? inner.aborted === 'idle'
          ? `idle_timeout (${idleTimeoutMs}ms without output)`
          : `timeout (${timeoutMs}ms)`
        : undefined;

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'exec',
        sourceContext,
        userId: opts.userId,
        command: this.truncateCommand(command),
        exitCode: inner.exitCode ?? undefined,
        durationMs,
        errorMsg: auditErrorMsg,
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

  // ===========================================================================
  // Async exec (T-388) — fire-and-poll for long-running operations
  // ===========================================================================
  //
  // Same execution pipeline as `exec()` but the returned promise resolves
  // with a jobId *immediately* — the actual command runs in the background.
  // Callers poll `getJobStatus(jobId)` to read live progress and the
  // eventual terminal state. Useful for ops that exceed sane MCP request
  // timeouts (deploys, long backups, multi-step pipelines).
  //
  // Lifecycle:
  //   1. acquireSlot — async jobs count against the per-connection limit
  //      just like sync execs; a flood of `ssh_exec_async` calls is *not*
  //      a back-door around the concurrency cap.
  //   2. job entry created in `execJobs`, `state='running'`
  //   3. background task opens client + invokes runExec with hooks that
  //      feed the rolling tail buffers
  //   4. on finalize the job's terminal fields are stamped, audit row
  //      written, client torn down, slot released, TTL timer armed
  //   5. polling can read the snapshot until JOB_TTL_MS elapses; after
  //      that the entry is reaped and status returns `null`
  //
  // The audit row is written exactly once per job (at finalize), matching
  // the sync exec path — replication / dashboards don't see a divergence
  // between the two surfaces.

  /**
   * Start a command in the background. Returns metadata for polling.
   * The full execution (open client, run exec, finalize, audit, cleanup)
   * is scheduled via `void` so the caller never waits for completion.
   */
  async execAsync(
    connId: string,
    command: string,
    opts: SshExecOpts = {},
  ): Promise<{
    jobId: string;
    connectionId: string;
    command: string;
    startedAt: string;
  }> {
    const sourceContext = opts.sourceContext ?? 'mcp';
    // Acquire the slot synchronously so a flood of async-execs still
    // respects CONCURRENCY_LIMIT. The slot is released by the background
    // task on finalize (or by the catastrophic-error branch).
    await this.acquireSlot(connId);

    const jobId = `ssh-job-${randomBytes(8).toString('hex')}`;
    const startedAt = Date.now();
    const job: ExecJob = {
      jobId,
      connectionId: connId,
      command,
      // wrappedCommand is computed once we know opts.cwd; placeholder for now.
      wrappedCommand: command,
      startedAt,
      sourceContext,
      userId: opts.userId,
      state: 'running',
      stdoutBytes: 0,
      stderrBytes: 0,
      lastChunkAt: null,
      stdoutTail: [],
      stdoutTailBytes: 0,
      stderrTail: [],
      stderrTailBytes: 0,
      exitCode: null,
    };
    this.execJobs.set(jobId, job);

    // Kick the actual exec into the background. We intentionally do NOT
    // await — control returns to the caller with the jobId immediately.
    void this.runJobBackground(job, opts).catch((err) => {
      // Catastrophic errors (credential_missing, openClient reject, etc.)
      // land here. Stamp the job as aborted/error and release the slot
      // we acquired synchronously above.
      this.logger.warn(`Async exec job ${jobId} failed before runExec: ${(err as Error).message}`);
      job.state = 'aborted';
      job.errorMsg = (err as Error).message;
      job.durationMs = Date.now() - job.startedAt;
      this.releaseSlot(connId);
      this.scheduleJobCleanup(job);
    });

    return {
      jobId,
      connectionId: connId,
      command,
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  /**
   * Snapshot of the job — safe to call any time. Returns `null` for unknown
   * or already-reaped jobIds so the MCP layer can map it to a clean
   * `job_not_found` error.
   */
  getJobStatus(jobId: string): SshExecJobStatus | null {
    const job = this.execJobs.get(jobId);
    if (!job) return null;
    return this.serialiseJob(job);
  }

  /**
   * Trigger a SIGTERM/SIGKILL cancel on a running async job. Idempotent —
   * cancelling a done/aborted job returns the existing status without
   * touching anything. Returns `null` for unknown jobIds.
   */
  cancelJob(jobId: string): SshExecJobStatus | null {
    const job = this.execJobs.get(jobId);
    if (!job) return null;
    if (job.state === 'running' && job.cancel) {
      try { job.cancel(); } catch { /* noop */ }
    }
    return this.serialiseJob(job);
  }

  // ---------------------------------------------------------------------------
  // Internals — async exec
  // ---------------------------------------------------------------------------

  /**
   * Background runner that owns the SSH client lifecycle for an async job.
   * Mirrors `exec()` but writes finalize state into the job table instead
   * of resolving a promise. Throws on catastrophic errors (caught by the
   * caller's `.catch` in `execAsync`).
   */
  private async runJobBackground(job: ExecJob, opts: SshExecOpts): Promise<void> {
    let client: Ssh2Client | null = null;
    try {
      const connection = await this.sshService.findById(job.connectionId);
      let creds: ResolvedCreds;
      try {
        creds = await this.resolveCredentials(connection);
      } catch (err) {
        await this.recordError(job.connectionId, 'credential_missing', err as Error);
        void this.writeAudit({
          connectionId: connection._id as Types.ObjectId,
          action: 'exec',
          sourceContext: job.sourceContext,
          userId: job.userId,
          command: this.truncateCommand(job.command),
          durationMs: Date.now() - job.startedAt,
          errorMsg: 'credential_missing',
        });
        throw new Error('credential_missing');
      }

      client = await this.openClient(connection, creds);
      const wrappedCommand = opts.cwd
        ? `cd '${this.shellSingleQuoteEscape(opts.cwd)}' && ${job.command}`
        : job.command;
      job.wrappedCommand = wrappedCommand;
      const timeoutMs = Math.min(
        Math.max(1, opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
        MAX_EXEC_TIMEOUT_MS,
      );
      const rawIdle = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const idleTimeoutMs =
        rawIdle <= 0 ? 0 : Math.min(Math.max(1, rawIdle), timeoutMs);

      const inner = await this.runExec(
        client,
        wrappedCommand,
        opts.env,
        timeoutMs,
        idleTimeoutMs,
        {
          // Mirror the running stdoutBytes/stderrBytes counters into the job
          // so a polling agent sees live progress while the command is still
          // running. The internal runExec counters are still the source of
          // truth for the final result (they reflect bytes ABOVE the
          // truncation cap correctly).
          onStdout: (chunk, totalBytes) => {
            job.stdoutBytes = totalBytes;
            this.appendTail(job.stdoutTail, chunk, TAIL_STDOUT_BYTES, 'stdout', job);
          },
          onStderr: (chunk, totalBytes) => {
            job.stderrBytes = totalBytes;
            this.appendTail(job.stderrTail, chunk, TAIL_STDERR_BYTES, 'stderr', job);
          },
          onCancelHandleReady: (cancelFn) => { job.cancel = cancelFn; },
        },
      );
      const durationMs = Date.now() - job.startedAt;

      // Stamp terminal state on the job. `state` is `aborted` only if the
      // escalation pipeline fired (timeout/idle/cancelled) OR the remote
      // killed us with a signal — a plain non-zero exit is still `done`.
      job.exitCode = inner.exitCode;
      job.signal = inner.signal;
      job.aborted = inner.aborted;
      job.durationMs = durationMs;
      job.truncated = inner.truncated;
      job.stdoutBytes = inner.stdoutBytes;
      job.stderrBytes = inner.stderrBytes;
      job.state = inner.aborted || inner.signal ? 'aborted' : 'done';

      const auditErrorMsg = inner.aborted
        ? inner.aborted === 'idle'
          ? `idle_timeout (${idleTimeoutMs}ms without output)`
          : inner.aborted === 'cancelled'
            ? 'cancelled (ssh_exec_cancel)'
            : `timeout (${timeoutMs}ms)`
        : undefined;

      void this.writeAudit({
        connectionId: connection._id as Types.ObjectId,
        action: 'exec',
        sourceContext: job.sourceContext,
        userId: job.userId,
        command: this.truncateCommand(job.command),
        exitCode: inner.exitCode ?? undefined,
        durationMs,
        errorMsg: auditErrorMsg,
      });
    } finally {
      if (client) {
        try { client.end(); } catch { /* noop */ }
        try { client.destroy(); } catch { /* noop */ }
      }
      this.releaseSlot(job.connectionId);
      this.scheduleJobCleanup(job);
    }
  }

  /**
   * Push a chunk into the rolling tail buffer, trimming from the front
   * whenever we exceed the cap. The buffer is a list of Buffers (not a
   * single Buffer.concat per chunk) so we don't pay the O(n) copy on
   * every byte — at most one O(remainder) subarray per overflow.
   */
  private appendTail(
    tail: Buffer[],
    chunk: Buffer,
    cap: number,
    stream: 'stdout' | 'stderr',
    job: ExecJob,
  ): void {
    tail.push(chunk);
    if (stream === 'stdout') {
      job.stdoutTailBytes += chunk.length;
      while (job.stdoutTailBytes > cap && tail.length > 0) {
        const first = tail[0]!;
        if (job.stdoutTailBytes - first.length >= cap) {
          tail.shift();
          job.stdoutTailBytes -= first.length;
        } else {
          const drop = job.stdoutTailBytes - cap;
          tail[0] = first.subarray(drop);
          job.stdoutTailBytes -= drop;
        }
      }
    } else {
      job.stderrTailBytes += chunk.length;
      while (job.stderrTailBytes > cap && tail.length > 0) {
        const first = tail[0]!;
        if (job.stderrTailBytes - first.length >= cap) {
          tail.shift();
          job.stderrTailBytes -= first.length;
        } else {
          const drop = job.stderrTailBytes - cap;
          tail[0] = first.subarray(drop);
          job.stderrTailBytes -= drop;
        }
      }
    }
    job.lastChunkAt = Date.now();
  }

  /**
   * Render the job into the public snapshot shape. Tail buffers are utf-8
   * decoded with U+FFFD replacement for invalid sequences (terminal stdout
   * is overwhelmingly text-shaped; binary payloads should use ssh_download
   * instead of polling stdout). Live progress fields are pulled directly
   * from the mutable job state.
   */
  private serialiseJob(job: ExecJob): SshExecJobStatus {
    const elapsedMs = (job.durationMs ?? Date.now() - job.startedAt);
    const lastChunkAgeMs =
      job.lastChunkAt === null
        ? 0
        : job.state === 'running'
          ? Math.max(0, Date.now() - job.lastChunkAt)
          : Math.max(0, (job.startedAt + (job.durationMs ?? 0)) - job.lastChunkAt);
    return {
      jobId: job.jobId,
      connectionId: job.connectionId,
      command: job.command,
      startedAt: new Date(job.startedAt).toISOString(),
      state: job.state,
      elapsedMs,
      stdoutTail: Buffer.concat(job.stdoutTail).toString('utf8'),
      stderrTail: Buffer.concat(job.stderrTail).toString('utf8'),
      stdoutBytes: job.stdoutBytes,
      stderrBytes: job.stderrBytes,
      lastChunkAgeMs,
      exitCode: job.exitCode,
      signal: job.signal ?? null,
      aborted: job.aborted ?? null,
      errorMsg: job.errorMsg ?? null,
      truncated: job.truncated ?? null,
      durationMs: job.durationMs ?? null,
    };
  }

  /**
   * Arm the TTL reaper for a finalised job. Re-armed safely if a status
   * call extends the window in a future iteration (today we just fire-
   * and-forget the timeout). Clear-and-rearm is idempotent.
   */
  private scheduleJobCleanup(job: ExecJob): void {
    if (job.ttlTimer) clearTimeout(job.ttlTimer);
    job.ttlTimer = setTimeout(() => {
      this.execJobs.delete(job.jobId);
    }, JOB_TTL_MS);
    // Don't keep the event loop alive solely for a stale job TTL.
    if (typeof job.ttlTimer.unref === 'function') job.ttlTimer.unref();
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
   * lifecycle. Handles stdout/stderr truncation and TWO independent abort
   * sources:
   *   - the absolute `timeoutMs` from spec §6.4 (full command duration cap)
   *   - the no-output watchdog `idleTimeoutMs` (T-387; catches the case where
   *     the SSH channel stays alive but the remote command silently went
   *     away — e.g. wedged php/composer process). Set to 0 to disable.
   *
   * Both sources funnel through the same SIGTERM→SIGKILL escalation; the
   * winning reason is stamped on `result.aborted` so the caller knows whether
   * the command timed out vs. stalled.
   */
  private runExec(
    client: Ssh2Client,
    command: string,
    env: Record<string, string> | undefined,
    timeoutMs: number,
    idleTimeoutMs: number,
    hooks?: {
      /**
       * Called for every stdout chunk, BEFORE the internal truncation buffer
       * decides to keep/drop bytes. `totalBytes` is the running stdoutBytes
       * counter after this chunk was added. Used by the async-exec job table
       * (T-388) to feed the rolling tail buffer.
       */
      onStdout?: (chunk: Buffer, totalBytes: number) => void;
      onStderr?: (chunk: Buffer, totalBytes: number) => void;
      /**
       * Receives a cancellation hook the moment the runner is wired up. The
       * callback triggers an `escalate('cancelled')` if the job is still
       * running; idempotent and a no-op after finalize. Used by the
       * `ssh_exec_cancel` MCP tool to interrupt long-running async jobs.
       */
      onCancelHandleReady?: (cancelFn: () => void) => void;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: string;
    truncated: { stdout: boolean; stderr: boolean };
    stdoutBytes: number;
    stderrBytes: number;
    lastChunkAgeMs: number;
    aborted?: 'timeout' | 'idle' | 'cancelled';
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
      let aborted: 'timeout' | 'idle' | 'cancelled' | undefined;
      let channel: ClientChannel | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let lastChunkAt: number | null = null;

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const armIdleTimer = () => {
        // idleTimeoutMs === 0 → caller opted out; skip the watchdog entirely.
        if (idleTimeoutMs <= 0) return;
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          // The watchdog fires whenever the gap since the last byte exceeds
          // idleTimeoutMs. Same SIGTERM/SIGKILL pipeline as the absolute
          // timeout; we only flag the `aborted` reason differently.
          escalate('idle');
        }, idleTimeoutMs);
      };

      const escalate = (reason: 'timeout' | 'idle' | 'cancelled') => {
        if (settled) return;
        // First escalation wins — both timers can fire in quick succession
        // (e.g. idleTimeoutMs == timeoutMs in tests) but we only want one
        // SIGTERM and one killTimer.
        if (aborted) return;
        aborted = reason;
        clearIdleTimer();
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
      };

      const finalize = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killTimer) clearTimeout(killTimer);
        clearIdleTimer();
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
        const lastChunkAgeMs =
          lastChunkAt === null ? 0 : Math.max(0, Date.now() - lastChunkAt);
        resolve({
          stdout,
          stderr,
          exitCode,
          signal,
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
          stdoutBytes,
          stderrBytes,
          lastChunkAgeMs,
          aborted,
        });
      };

      // Surface the cancel hook before any I/O so a caller racing to cancel
      // (e.g. ssh_exec_cancel arriving before the exec callback fires) can
      // already trip the escalation pipeline. The cancel function itself
      // tolerates being called pre-channel-ready — escalate's `if (channel)`
      // guards the signal call.
      if (hooks?.onCancelHandleReady) {
        try { hooks.onCancelHandleReady(() => escalate('cancelled')); } catch { /* noop */ }
      }

      const execOpts = env ? { env } : {};
      // Arm BOTH watchdogs synchronously before the exec call. This catches
      // the case where the SSH channel never opens at all (the user's original
      // bug: command never reached the remote, MCP-bridge stayed silent for
      // an hour) — without an idle counter pre-armed, a missing data stream
      // would only be rescued by the absolute timeout. We arm idle first so
      // that the FIFO-fire test patch picks the idle path deterministically;
      // production timer order is governed by actual ms values, not arming
      // sequence.
      armIdleTimer();
      timeoutHandle = setTimeout(() => {
        escalate('timeout');
      }, timeoutMs);

      try {
        client.exec(command, execOpts, (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            if (settled) return;
            settled = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (killTimer) clearTimeout(killTimer);
            clearIdleTimer();
            reject(err);
            return;
          }
          channel = stream;

          stream.on('data', (chunk: Buffer) => {
            lastChunkAt = Date.now();
            armIdleTimer();
            if (stdoutBytes >= STDOUT_LIMIT) {
              stdoutBytes += chunk.length;
              stdoutTruncated = true;
            } else if (stdoutBytes + chunk.length <= STDOUT_LIMIT) {
              stdoutChunks.push(chunk);
              stdoutBytes += chunk.length;
            } else {
              const space = STDOUT_LIMIT - stdoutBytes;
              if (space > 0) stdoutChunks.push(chunk.subarray(0, space));
              stdoutBytes += chunk.length;
              stdoutTruncated = true;
            }
            // Hook fires AFTER stdoutBytes is updated so async-job callers get
            // the running total alongside the chunk. Wrapped in try so a
            // throwing hook can't tear down the SSH session.
            if (hooks?.onStdout) {
              try { hooks.onStdout(chunk, stdoutBytes); } catch { /* noop */ }
            }
          });

          stream.stderr.on('data', (chunk: Buffer) => {
            lastChunkAt = Date.now();
            armIdleTimer();
            if (stderrBytes >= STDERR_LIMIT) {
              stderrBytes += chunk.length;
              stderrTruncated = true;
            } else if (stderrBytes + chunk.length <= STDERR_LIMIT) {
              stderrChunks.push(chunk);
              stderrBytes += chunk.length;
            } else {
              const space = STDERR_LIMIT - stderrBytes;
              if (space > 0) stderrChunks.push(chunk.subarray(0, space));
              stderrBytes += chunk.length;
              stderrTruncated = true;
            }
            if (hooks?.onStderr) {
              try { hooks.onStderr(chunk, stderrBytes); } catch { /* noop */ }
            }
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
        clearIdleTimer();
        reject(err as Error);
        return;
      }
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
