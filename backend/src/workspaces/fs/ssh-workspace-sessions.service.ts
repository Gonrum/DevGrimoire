import type { Readable, Writable } from 'node:stream';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { Client as Ssh2Client } from 'ssh2';
import { SshSessionService } from '../../ssh/ssh-session.service';
import { SshService } from '../../ssh/ssh.service';
import { OutboundBlockedException } from '../../common/outbound-guard';
import { errorMessage, isRecord } from '../../common/narrow';
import {
  PROBE_COMMAND,
  RemoteError,
  RemoteFs,
  RemoteProbe,
  RemoteSession,
  RemoteSessionDriver,
  SSH_EXEC_MAX_OUTPUT_BYTES,
  SSH_SESSION_IDLE_MS,
  SSH_SESSION_MAX_EXEC,
  SSH_SESSION_OP_TIMEOUT_MS,
  isRemoteError,
  parseProbeOutput,
} from './remote-session';
import type { RemoteDriverFactory } from './remote-session';
import { createSsh2Driver } from './ssh2-remote-session';

/** DI token for the driver factory (checks replace it with a fake). */
export const SSH_REMOTE_DRIVER_FACTORY = 'SSH_REMOTE_DRIVER_FACTORY';

/** Extra time on top of an exec's own timeout before the wrapper gives up on the driver. */
const EXEC_TIMEOUT_GRACE_MS = 2_000;
/**
 * Whole-file reads and writes are transfers: their timeout grows with the
 * size (the absolute op timeout plus 1 s per 256 KiB), so a 100 MiB editor
 * file on a slow link is not cut off while a stalled server still is.
 */
const TRANSFER_BYTES_PER_SECOND = 256 * 1024;

interface Live {
  client: Ssh2Client;
  driver: RemoteSessionDriver;
  session: RemoteSession;
}

interface EntryState {
  workspaceId: string;
  connectionId: string;
  live?: Live;
  /** In-flight operations, open streams and running `withSession` callbacks. */
  refs: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  /** The client or a channel reported loss while the entry was open. */
  lost: boolean;
  execActive: number;
  /** FIFO waiters for an exec slot; `true` = slot handed over, `false` = session closed. */
  execQueue: Array<(granted: boolean) => void>;
  probe?: Promise<RemoteProbe>;
}

interface Entry extends EntryState {
  ready: Promise<Live>;
}

export interface WithSessionOpts {
  /**
   * Read-only operations: on `disconnected`/`timeout` (or a client lost during
   * the call) the session is dropped and `fn` runs once more on a fresh one.
   * Never set for writes or uploads.
   */
  retryable?: boolean;
  /**
   * Called once when this call had to open a new session and it came up
   * (audit "session opened"). Not called when an existing session was reused.
   */
  onConnect?: () => void;
}

/**
 * One held ssh2 client plus one SFTP channel per SSH workspace. The IDE fires
 * many small requests; a handshake per request would be far too slow.
 *
 * - Concurrent first calls share one connect (`SshSessionService.connect`,
 *   which owns TOFU and credentials).
 * - Closed after `idleMs` without activity; in-flight operations and open
 *   streams count as activity until they settle / close.
 * - `exec` runs at most `SSH_SESSION_MAX_EXEC` at a time per session (FIFO).
 * - `disconnected`/`timeout` drop the session; retryable callers get one
 *   more attempt on a fresh session.
 *
 * Deliberately not routed through SshSessionService's per-connection
 * semaphore: that one caps one-shot operations, this is one long-lived
 * session per workspace.
 */
@Injectable()
export class SshWorkspaceSessions implements OnModuleDestroy {
  private readonly logger = new Logger(SshWorkspaceSessions.name);
  private readonly entries = new Map<string, Entry>();

  /** Overridable by checks. */
  idleMs = SSH_SESSION_IDLE_MS;
  opTimeoutMs = SSH_SESSION_OP_TIMEOUT_MS;
  execGraceMs = EXEC_TIMEOUT_GRACE_MS;

  constructor(
    private readonly connector: SshSessionService,
    private readonly ssh: SshService,
    @Optional()
    @Inject(SSH_REMOTE_DRIVER_FACTORY)
    private readonly factory: RemoteDriverFactory<Ssh2Client> = createSsh2Driver,
  ) {}

  async withSession<T>(
    workspaceId: string,
    connectionId: string,
    fn: (s: RemoteSession) => Promise<T>,
    opts: WithSessionOpts = {},
  ): Promise<T> {
    const first = this.entryFor(workspaceId, connectionId, opts.onConnect);
    try {
      return await this.run(first, fn);
    } catch (err: unknown) {
      // An exec timeout leaves the session open on purpose: neither drop nor retry.
      if (isRemoteError(err) && err.code === 'timeout' && !first.closed) throw err;
      if (!this.isTransient(err, first)) throw err;
      this.closeEntry(first);
      if (!opts.retryable) throw this.normalise(err, first);
    }
    const second = this.entryFor(workspaceId, connectionId, opts.onConnect);
    try {
      return await this.run(second, fn);
    } catch (err: unknown) {
      const keptOpen = isRemoteError(err) && err.code === 'timeout' && !second.closed;
      if (!keptOpen && this.isTransient(err, second)) this.closeEntry(second);
      throw this.normalise(err, second);
    }
  }

  /** Closes the session of one workspace (archive, delete). */
  drop(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (entry) this.closeEntry(entry);
  }

  /** Closes every session using this connection (connection changed or deleted). */
  dropByConnection(connectionId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.connectionId === connectionId) this.closeEntry(entry);
    }
  }

  onModuleDestroy(): void {
    for (const entry of [...this.entries.values()]) this.closeEntry(entry);
  }

  // -------------------------------------------------------------------------
  // Entry lifecycle
  // -------------------------------------------------------------------------

  private entryFor(workspaceId: string, connectionId: string, onConnect?: () => void): Entry {
    const existing = this.entries.get(workspaceId);
    if (existing && existing.connectionId === connectionId && !existing.closed) return existing;
    if (existing) this.closeEntry(existing);
    const state: EntryState = {
      workspaceId,
      connectionId,
      refs: 0,
      closed: false,
      lost: false,
      execActive: 0,
      execQueue: [],
    };
    const entry: Entry = Object.assign(state, { ready: this.establish(state) });
    this.entries.set(workspaceId, entry);
    // A failed connect is not memoised: the next call starts over.
    entry.ready.catch(() => this.closeEntry(entry));
    if (onConnect) entry.ready.then(() => safe(onConnect), () => undefined);
    return entry;
  }

  private async establish(state: EntryState): Promise<Live> {
    let client: Ssh2Client;
    try {
      client = await this.connector.connect(state.connectionId);
    } catch (err: unknown) {
      throw await this.connectError(err, state.connectionId);
    }
    if (state.closed) {
      endClient(client);
      throw new RemoteError('disconnected', 'SSH session was dropped while connecting');
    }
    const onLost = (err?: Error): void => {
      if (state.closed) return;
      state.lost = true;
      this.logger.debug(
        `SSH session of workspace ${state.workspaceId} lost${err ? `: ${err.message}` : ''}`,
      );
      this.closeEntry(state);
    };
    client.on('error', (err: Error) => onLost(err));
    client.on('close', () => onLost());

    let driver: RemoteSessionDriver;
    try {
      driver = await this.openDriver(client, onLost);
    } catch (err: unknown) {
      endClient(client);
      if (state.closed) throw new RemoteError('disconnected', 'SSH session was dropped while connecting');
      if (isRemoteError(err) && err.code === 'timeout') throw err;
      const label = await this.labelOf(state.connectionId);
      throw new HttpException(
        {
          error: 'sftp_unavailable',
          message: `SSH-Verbindung "${label}": SFTP-Kanal konnte nicht geöffnet werden (${errorMessage(err)})`,
        },
        502,
      );
    }
    if (state.closed) {
      safe(() => driver.close());
      endClient(client);
      throw new RemoteError('disconnected', 'SSH session was dropped while connecting');
    }
    const live: Live = { client, driver, session: this.wrap(state, driver) };
    state.live = live;
    return live;
  }

  /**
   * Opens the SFTP channel under the op timeout: a server that never answers
   * the subsystem request must fail instead of hanging every caller. A driver
   * arriving after the timeout is closed again.
   */
  private openDriver(client: Ssh2Client, onLost: (err?: Error) => void): Promise<RemoteSessionDriver> {
    return new Promise<RemoteSessionDriver>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new RemoteError('timeout', `SFTP channel did not open within ${this.opTimeoutMs} ms`));
      }, this.opTimeoutMs);
      this.factory(client, { onLost }).then(
        (driver) => {
          clearTimeout(timer);
          if (timedOut) safe(() => driver.close());
          else resolve(driver);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(errorMessage(err)));
        },
      );
    });
  }

  private closeEntry(state: EntryState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (this.entries.get(state.workspaceId) === state) this.entries.delete(state.workspaceId);
    for (const waiter of state.execQueue.splice(0)) waiter(false);
    const live = state.live;
    if (live) {
      safe(() => live.driver.close());
      endClient(live.client);
    }
    // Still connecting: `establish` sees `closed` and ends the client itself.
  }

  private async run<T>(entry: Entry, fn: (s: RemoteSession) => Promise<T>): Promise<T> {
    const release = this.hold(entry);
    try {
      const live = await entry.ready;
      return await fn(live.session);
    } finally {
      release();
    }
  }

  /** Counts one activity; the returned release is idempotent. */
  private hold(state: EntryState): () => void {
    state.refs += 1;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.refs -= 1;
      if (state.refs === 0 && !state.closed) this.scheduleIdle(state);
    };
  }

  private scheduleIdle(state: EntryState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (state.refs === 0) this.closeEntry(state);
    }, this.idleMs);
    state.idleTimer.unref();
  }

  private isTransient(err: unknown, state: EntryState): boolean {
    if (isRemoteError(err)) return err.code === 'disconnected' || err.code === 'timeout';
    // A connect failure is an HttpException and never transient.
    return state.lost && !(err instanceof HttpException);
  }

  /** Raw errors after a lost client become `disconnected`. */
  private normalise(err: unknown, state: EntryState): unknown {
    if (isRemoteError(err) || err instanceof HttpException || !state.lost) return err;
    return new RemoteError('disconnected', errorMessage(err));
  }

  // -------------------------------------------------------------------------
  // Session wrapper: activity, timeouts, exec cap, probe cache
  // -------------------------------------------------------------------------

  private wrap(state: EntryState, driver: RemoteSessionDriver): RemoteSession {
    const op = <T>(name: string, work: () => Promise<T>, timeoutMs = this.opTimeoutMs): Promise<T> =>
      this.guarded(state, name, timeoutMs, work, true);
    const transferMs = (bytes: number): number =>
      this.opTimeoutMs + Math.ceil((bytes / TRANSFER_BYTES_PER_SECOND) * 1000);
    const raw = driver.fs;
    const fs: RemoteFs = {
      stat: (p) => op('stat', () => raw.stat(p)),
      lstat: (p) => op('lstat', () => raw.lstat(p)),
      realpath: (p) => op('realpath', () => raw.realpath(p)),
      readdir: (p) => op('readdir', () => raw.readdir(p)),
      // The timeout follows the actual size (one extra stat), not the cap: a
      // 100 MiB cap must not give a stalled 1 KiB read seven minutes.
      readFile: async (p, maxBytes) => {
        const st = await op('stat', () => raw.stat(p));
        return op('readFile', () => raw.readFile(p, maxBytes), transferMs(Math.min(st.size, maxBytes)));
      },
      writeFile: (p, data, mode) => op('writeFile', () => raw.writeFile(p, data, mode), transferMs(data.length)),
      rename: (from, to) => op('rename', () => raw.rename(from, to)),
      posixRename: (from, to) => op('posixRename', () => raw.posixRename(from, to)),
      unlink: (p) => op('unlink', () => raw.unlink(p)),
      mkdir: (p) => op('mkdir', () => raw.mkdir(p)),
      chmod: (p, mode) => op('chmod', () => raw.chmod(p, mode)),
      // Streams are exempt from the absolute timeout (callers apply an idle
      // rule) but hold the session open until they close.
      createReadStream: (p): Readable => this.holdStream(state, raw.createReadStream(p)),
      createWriteStream: (p, mode): Writable => this.holdStream(state, raw.createWriteStream(p, mode)),
    };
    const exec: RemoteSession['exec'] = async (command, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? this.opTimeoutMs;
      const maxOutputBytes = opts.maxOutputBytes ?? SSH_EXEC_MAX_OUTPUT_BYTES;
      const terminateOnTimeout = opts.terminateOnTimeout !== false;
      const outputMode = opts.outputMode === 'headTail' ? 'headTail' : 'stop';
      const signal = opts.signal;
      const release = this.hold(state);
      try {
        await this.acquireExec(state, signal);
        try {
          // An exec timeout closes only its own channel (the driver does that)
          // and keeps the session: a search returning partial results must not
          // kill parallel downloads.
          return await this.guarded(state, 'exec', timeoutMs + this.execGraceMs, () =>
            driver.exec(command, {
              timeoutMs, maxOutputBytes, terminateOnTimeout, outputMode, ...(signal ? { signal } : {}),
            }),
          false);
        } finally {
          this.releaseExec(state);
        }
      } finally {
        release();
      }
    };
    const probe = (): Promise<RemoteProbe> => {
      if (!state.probe) {
        const running = exec(PROBE_COMMAND).then((r) => parseProbeOutput(r.stdout));
        state.probe = running;
        // A failed probe is not cached.
        running.catch(() => {
          if (state.probe === running) state.probe = undefined;
        });
      }
      return state.probe;
    };
    return { fs, exec, probe };
  }

  /**
   * Runs one operation with activity, a timeout and error normalisation.
   * `disconnected` (or any failure after the client was lost) drops the
   * session; `timeout` only when `dropOnTimeout` (SFTP single operations).
   */
  private async guarded<T>(
    state: EntryState,
    name: string,
    timeoutMs: number,
    work: () => Promise<T>,
    dropOnTimeout: boolean,
  ): Promise<T> {
    const release = this.hold(state);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (state.closed) throw new RemoteError('disconnected', `${name}: SSH session closed`);
      const running = work();
      // The abandoned promise of a timed-out op must not reject unhandled.
      running.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RemoteError('timeout', `${name} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      return await Promise.race([running, timeout]);
    } catch (err: unknown) {
      const normalised = this.normalise(err, state);
      const keep = !dropOnTimeout && isRemoteError(normalised) && normalised.code === 'timeout' && !state.lost;
      if (!keep && this.isTransient(normalised, state)) this.closeEntry(state);
      throw normalised;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  private holdStream<S extends Readable | Writable>(state: EntryState, stream: S): S {
    const release = this.hold(state);
    stream.once('close', release);
    stream.once('error', release);
    return stream;
  }

  /** An aborted `signal` rejects with `aborted`; a queued waiter then leaves the queue. */
  private async acquireExec(state: EntryState, signal?: AbortSignal): Promise<void> {
    if (state.closed) throw new RemoteError('disconnected', 'exec: SSH session closed');
    if (signal?.aborted) throw new RemoteError('aborted', 'exec aborted');
    if (state.execActive < SSH_SESSION_MAX_EXEC) {
      state.execActive += 1;
      return;
    }
    let onAbort: (() => void) | undefined;
    const outcome = await new Promise<'granted' | 'closed' | 'aborted'>((resolve) => {
      const waiter = (granted: boolean): void => resolve(granted ? 'granted' : 'closed');
      state.execQueue.push(waiter);
      if (signal) {
        onAbort = () => {
          const i = state.execQueue.indexOf(waiter);
          // Already handed a slot: the grant wins and the driver sees the abort.
          if (i >= 0) {
            state.execQueue.splice(i, 1);
            resolve('aborted');
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (outcome === 'closed') throw new RemoteError('disconnected', 'exec: SSH session closed');
    if (outcome === 'aborted') throw new RemoteError('aborted', 'exec aborted');
  }

  private releaseExec(state: EntryState): void {
    const next = state.execQueue.shift();
    // Slot handover: `execActive` stays as it is when a waiter takes over.
    if (next) next(true);
    else state.execActive -= 1;
  }

  // -------------------------------------------------------------------------
  // Connect errors
  // -------------------------------------------------------------------------

  private async labelOf(connectionId: string): Promise<string> {
    try {
      return (await this.ssh.findById(connectionId)).label;
    } catch {
      return connectionId;
    }
  }

  private async connectError(err: unknown, connectionId: string): Promise<HttpException> {
    if (
      err instanceof HttpException
      && !(err instanceof NotFoundException)
      && !(err instanceof OutboundBlockedException)
    ) {
      return err;
    }
    const label = await this.labelOf(connectionId);
    const conn = `SSH-Verbindung "${label}"`;
    const fail = (status: number, error: string, message: string): HttpException =>
      new HttpException({ error, message }, status);

    if (err instanceof NotFoundException) {
      return fail(409, 'connection_missing', `${conn} existiert nicht mehr`);
    }
    if (err instanceof OutboundBlockedException) {
      return fail(409, 'target_blocked', `${conn}: Ziel ist nicht erlaubt (${err.message})`);
    }
    const message = errorMessage(err);
    const level = isRecord(err) && typeof err.level === 'string' ? err.level : '';
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : '';
    if (message === 'tofu_not_accepted') {
      return fail(409, 'tofu_not_accepted',
        `${conn}: Fingerprint nicht akzeptiert — auf der Verbindungsseite bestätigen`);
    }
    if (message === 'host_key_mismatch') {
      return fail(409, 'host_key_mismatch',
        `${conn}: Host-Schlüssel weicht vom gespeicherten Fingerprint ab — auf der Verbindungsseite prüfen`);
    }
    if (message === 'credential_missing') {
      return fail(409, 'credential_missing',
        `${conn}: Zugangsdaten fehlen — auf der Verbindungsseite neu hinterlegen`);
    }
    if (
      level === 'client-authentication'
      || message === 'auth_failed'
      || message.startsWith('auth_failed:')
      || /authentication/i.test(message)
    ) {
      return fail(409, 'auth_failed', `${conn}: Anmeldung fehlgeschlagen — Zugangsdaten prüfen`);
    }
    if (level === 'client-timeout' || code === 'ETIMEDOUT' || /timed out/i.test(message)) {
      return fail(504, 'timeout', `${conn}: Zeitüberschreitung beim Verbindungsaufbau`);
    }
    return fail(502, 'connect_failed', `${conn} nicht erreichbar: ${message}`);
  }
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* best effort */ }
}

function endClient(client: Ssh2Client): void {
  safe(() => client.end());
  safe(() => client.destroy());
}
