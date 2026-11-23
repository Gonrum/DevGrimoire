import WebSocket from 'ws';
import type { Client, ClientChannel } from 'ssh2';
import { errorMessage, isRecord } from '../common/narrow';
import { shq } from '../common/shell-quote';

/**
 * Close code for a terminal closed after its idle limit (no input from the
 * browser and no output from the shell). Sent by this bridge and by the
 * workspace sidecar; the frontend shows "closed due to inactivity" for it and
 * does not treat it as an error. Sits next to the SSH connect codes 4001-4008
 * (see `sshConnectErrorToCloseCode`).
 */
export const TERMINAL_IDLE_CLOSE_CODE = 4010;
export const TERMINAL_IDLE_CLOSE_REASON = 'idle_timeout';

/** Stdin typed before the channel exists is buffered up to this many bytes. */
export const EARLY_STDIN_MAX_BYTES = 64 * 1024;
/**
 * Close code and reason when more stdin arrived before the shell was ready
 * than fits the buffer. 1009 = "message too big". The whole early input is
 * discarded: running a paste with a hole in it would be worse than nothing.
 */
export const EARLY_INPUT_OVERFLOW_CLOSE_CODE = 1009;
export const EARLY_INPUT_OVERFLOW_REASON = 'early_input_overflow';

/**
 * `ws` delivers messages as `RawData` (`Buffer | ArrayBuffer | Buffer[]`). A
 * plain `data.toString()` turns a fragmented frame into a comma-joined list and
 * an `ArrayBuffer` into `[object ArrayBuffer]`.
 */
export function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * PTY size from a `resize` frame or the query string. Only whole, positive
 * values in a plausible range: a broken frame must not set the PTY to 0 or to
 * millions of columns.
 */
export function toPtySize(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isInteger(c) || !Number.isInteger(r)) return undefined;
  if (c < 1 || r < 1 || c > 1000 || r > 1000) return undefined;
  return { cols: c, rows: r };
}

/** Resize message sent by the client; unchecked JSON, hence `unknown`. */
function asResizeMessage(value: unknown): { cols: unknown; rows: unknown } | undefined {
  if (!isRecord(value) || value.type !== 'resize') return undefined;
  return { cols: value.cols, rows: value.rows };
}

/**
 * Close-code mapping for SSH connect/auth failures (Spec §4.3):
 *   host_key_mismatch    → 4001 (spec-mandated)
 *   tofu_not_accepted    → 4002
 *   credential_missing   → 4003
 *   auth_failed          → 4004
 *   timeout / network    → 4008
 *   anything else        → 1011 (internal server error)
 * Idle close (not a connect failure) uses TERMINAL_IDLE_CLOSE_CODE = 4010.
 * The reason string is the raw error code so the frontend can also
 * disambiguate without depending on the numeric mapping.
 */
export function sshConnectErrorToCloseCode(reason: string): number {
  // Match prefix-style (some errors include extra context after the code,
  // e.g. "upload_too_large: 12345 > 10485760").
  const head = reason.split(/[:\s]/, 1)[0] || reason;
  switch (head) {
    case 'host_key_mismatch':
      return 4001;
    case 'tofu_not_accepted':
      return 4002;
    case 'credential_missing':
      return 4003;
    case 'auth_failed':
      return 4004;
    case 'timeout':
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ECONNRESET':
      return 4008;
    default:
      return 1011;
  }
}

/**
 * Remote command that starts a login shell in `path`. If `cd` fails, the
 * shell is not started: the error goes to the terminal and the channel exits.
 */
export function cwdShellCommand(path: string): string {
  return `cd -- ${shq(path)} && exec "\${SHELL:-/bin/sh}" -l`;
}

export interface BridgeSshTerminalOpts {
  clientWs: WebSocket;
  connect: () => Promise<Client>;
  start: { kind: 'shell' } | { kind: 'cwd'; path: string };
  initial: { cols: number; rows: number };
  /** Close the terminal after this long without input and without output. */
  idleMs: number;
  audit: (action: 'terminal_open' | 'terminal_close', durationMs?: number) => void;
}

/**
 * Bridges an already upgraded browser WebSocket to an interactive SSH channel.
 *
 * Control-frame protocol mirrors the workspace (sidecar) terminal so the
 * frontend shares one component: JSON `{type:'resize', cols, rows}` from
 * client to server, JSON `{type:'exit', exitCode}` from server to client. All
 * other frames are stdin/stdout bytes. Connect errors close the socket with
 * `sshConnectErrorToCloseCode(reason)`; the idle limit closes it with
 * TERMINAL_IDLE_CLOSE_CODE.
 *
 * Resolves once the connect phase is over (the session itself keeps running
 * on its listeners).
 */
export async function bridgeSshTerminal(opts: BridgeSshTerminalOpts): Promise<void> {
  const { clientWs, start, idleMs, audit } = opts;
  const startedAt = Date.now();
  let sshClient: Client | null = null;
  let channel: ClientChannel | null = null;
  let closed = false;
  let opened = false;

  // Idle limit: one timer, re-armed for the remaining time whenever it fires
  // after activity (cheaper than resetting a timer on every output chunk).
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | null = null;
  const touch = () => { lastActivity = Date.now(); };
  const armIdle = (delay: number) => {
    idleTimer = setTimeout(checkIdle, delay);
    idleTimer.unref?.();
  };
  const checkIdle = () => {
    idleTimer = null;
    if (closed) return;
    const left = lastActivity + idleMs - Date.now();
    if (left > 0) {
      armIdle(left);
      return;
    }
    closeAll(TERMINAL_IDLE_CLOSE_CODE, TERMINAL_IDLE_CLOSE_REASON);
  };

  const closeAll = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    try { clientWs.close(code, reason); } catch { /* noop */ }
    try { channel?.close(); } catch { /* noop */ }
    try { sshClient?.end(); } catch { /* noop */ }
    try { sshClient?.destroy(); } catch { /* noop */ }
    // Duration is end-to-end WS lifetime, which is the only "session
    // duration" the user cares about.
    if (opened) audit('terminal_close', Date.now() - startedAt);
  };

  // Latest PTY size the browser asked for. The frontend sends its first
  // `resize` frame on WS-open, i.e. while `connect()` below is still
  // negotiating, so the handler is registered right here and the remembered
  // size feeds the channel once it opens.
  let ptySize = { ...opts.initial };
  // Stdin typed before the channel exists (e.g. the IDE's "open in terminal"
  // `cd`, sent right on WS-open). Bounded: on overflow everything buffered
  // and everything after it is discarded and the terminal is closed, so no
  // part of it ever reaches the shell.
  const early: Buffer[] = [];
  let earlyBytes = 0;
  let earlyOverflow = false;
  const writeStdin = (data: string | Buffer) => {
    if (closed || earlyOverflow) return;
    if (channel) {
      try { channel.write(data); } catch { /* noop */ }
      return;
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (earlyBytes + buf.length > EARLY_STDIN_MAX_BYTES) {
      earlyOverflow = true;
      early.length = 0;
      earlyBytes = 0;
      closeAll(EARLY_INPUT_OVERFLOW_CLOSE_CODE, EARLY_INPUT_OVERFLOW_REASON);
      return;
    }
    early.push(buf);
    earlyBytes += buf.length;
  };

  clientWs.on('message', (data, isBinary) => {
    touch();
    if (!isBinary) {
      const text = rawDataToString(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined; // Not JSON: treated as stdin below.
      }
      const resize = asResizeMessage(parsed);
      if (resize) {
        const size = toPtySize(resize.cols, resize.rows);
        if (size) {
          ptySize = size;
          if (channel) {
            try { channel.setWindow(size.rows, size.cols, 0, 0); } catch { /* noop */ }
          }
        }
        return;
      }
      writeStdin(text);
      return;
    }
    writeStdin(rawDataToBuffer(data));
  });

  // Also before `connect()`: a browser that gives up while the SSH handshake
  // is still running must mark the session closed, otherwise the shell below
  // was opened anyway with nobody attached.
  clientWs.on('close', () => closeAll());
  clientWs.on('error', () => closeAll(1011, 'ws_error'));
  armIdle(idleMs);

  let client: Client;
  try {
    client = await opts.connect();
  } catch (err) {
    const reason = errorMessage(err) || 'ssh_connect_failed';
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    try { clientWs.close(sshConnectErrorToCloseCode(reason), reason); } catch { /* noop */ }
    return;
  }

  if (closed) {
    // WS went away during the handshake: `closeAll()` already ran with
    // `sshClient === null`, so the fresh client is ours to release. An
    // 'error' without a listener would take the whole process down.
    client.on('error', () => { /* already closing */ });
    try { client.end(); } catch { /* noop */ }
    try { client.destroy(); } catch { /* noop */ }
    return;
  }
  sshClient = client;
  opened = true;
  touch();
  audit('terminal_open');

  const onChannel = (err: Error | undefined, stream: ClientChannel) => {
    if (err) {
      // Post-connect failure -> 1011; the 4xxx codes are for connect/auth.
      closeAll(1011, `shell_failed: ${err.message}`);
      return;
    }
    if (closed) {
      try { stream.close(); } catch { /* noop */ }
      return;
    }
    channel = stream;
    // A resize may have landed between the request and this callback.
    try { stream.setWindow(ptySize.rows, ptySize.cols, 0, 0); } catch { /* noop */ }
    for (const buf of early.splice(0)) {
      try { stream.write(buf); } catch { /* noop */ }
    }
    earlyBytes = 0;

    // SSH -> WS: stdout and stderr as binary frames (xterm handles one stream).
    const forward = (chunk: Buffer) => {
      touch();
      if (clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.send(chunk, { binary: true }); } catch { /* noop */ }
      }
    };
    stream.on('data', forward);
    stream.stderr.on('data', forward);

    // Same protocol as the sidecar terminal on exit: JSON text frame.
    stream.on('exit', (code: number | null) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: 'exit', exitCode: code ?? null }));
        } catch { /* noop */ }
      }
    });
    stream.on('close', () => closeAll());
  };

  const pty = { term: 'xterm-256color', cols: ptySize.cols, rows: ptySize.rows };
  if (start.kind === 'cwd') {
    client.exec(cwdShellCommand(start.path), { pty }, onChannel);
  } else {
    client.shell(pty, onChannel);
  }

  client.on('end', () => closeAll());
  client.on('close', () => closeAll());
  client.on('error', (err) => closeAll(1011, err.message || 'ssh_error'));
}
