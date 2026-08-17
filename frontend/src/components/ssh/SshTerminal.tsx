import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import Button from '../ui/Button';
import { parseJsonText } from '../../api/http-boundary';
import { isRecord } from '../../lib/narrow';

/**
 * Optional runtime override `window.__DG_API_URL__` (set by a deployment that
 * serves the SPA from a different origin than the API). Read through a
 * predicate instead of a cast: nothing in this repo declares or writes the
 * global, so its presence and type are genuinely unknown at build time.
 */
function readApiBaseUrl(): string {
  const globals: unknown = globalThis;
  if (isRecord(globals)) {
    const configured = globals.__DG_API_URL__;
    if (typeof configured === 'string' && configured.length > 0) return configured;
  }
  return '/api';
}

const BASE_URL = readApiBaseUrl();

export interface SshTerminalProps {
  connectionId: string;
  connectionLabel: string;
  hostInfo: string;
  authToken: string | null;
  onClose?: () => void;
  /** Called when the WS state transitions (used by parent for Esc-confirm). */
  onConnectionStateChange?: (state: TerminalState) => void;
}

export type TerminalState =
  | 'connecting'
  | 'connected'
  | 'exited'
  | 'disconnected'
  | 'error';

function buildWsUrl(connectionId: string, token: string | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const apiPath = BASE_URL.startsWith('http')
    ? BASE_URL.replace(/^http/i, proto)
    : `${proto}://${window.location.host}${BASE_URL}`;
  const url = new URL(`${apiPath}/ssh/${connectionId}/terminal`);
  url.searchParams.set('token', token || '');
  return url.toString();
}

/**
 * Map close codes from the backend SSH WS gateway (T-380) to a
 * user-readable reason. Falls back to the raw code/reason when unknown.
 *
 * Codes per Spec §4.3 / §7.5:
 *   4001 host_key_mismatch
 *   4002 tofu_not_accepted
 *   4003 credential_missing
 *   4004 auth_failed
 *   4008 timeout / network
 *   1011 internal
 */
function describeCloseCode(
  code: number,
  reason: string,
  t: (key: string) => string,
): string {
  switch (code) {
    case 4001:
      return t('ssh.terminal.closeReason.host_key_mismatch');
    case 4002:
      return t('ssh.terminal.closeReason.tofu_not_accepted');
    case 4003:
      return t('ssh.terminal.closeReason.credential_missing');
    case 4004:
      return t('ssh.terminal.closeReason.auth_failed');
    case 4008:
      return t('ssh.terminal.closeReason.timeout');
    case 1011:
      return t('ssh.terminal.closeReason.internal');
    case 1000:
    case 1005:
    case 1006:
      return t('ssh.terminal.closeReason.normal');
    default:
      return reason ? `${code}: ${reason}` : String(code);
  }
}

/** Control frame the gateway sends as a text message (Spec §4.3). */
interface SshControlFrame {
  type: string;
  exitCode?: number;
}

/**
 * Read a text WS message as a control frame.
 *
 * Returns `null` for anything that isn't a well-formed frame — invalid JSON,
 * a JSON scalar, or a missing `type`. The caller then writes the payload to
 * the terminal as raw text. Deliberately non-throwing: a bad frame may be
 * discarded, but it must not escape the `onmessage` handler and tear down the
 * session.
 */
function parseControlFrame(text: string): SshControlFrame | null {
  let parsed: unknown;
  try {
    parsed = parseJsonText<unknown>(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
  return {
    type: parsed.type,
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
  };
}

/**
 * Live SSH terminal — mirrors `WorkspaceTerminal` because the backend
 * (T-380) re-uses the same control protocol (`resize` / `exit`). Only the
 * WS endpoint and the header styling differ.
 */
export default function SshTerminal({
  connectionId,
  connectionLabel,
  hostInfo,
  authToken,
  onClose,
  onConnectionStateChange,
}: SshTerminalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [state, setState] = useState<TerminalState>('connecting');
  const [closeInfo, setCloseInfo] = useState<{ code: number; reason: string } | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  // Option A: hold both the current state and the (potentially changing)
  // callback in refs so the WS handlers always see the latest values
  // *without* re-running the connect-effect on every parent re-render.
  // - `stateRef` lets the `onclose` handler check `prev === 'exited'`
  //   without resorting to a side-effectful `setState`-updater (which is
  //   unsafe under React StrictMode double-invoke).
  // - `onStateChangeRef` decouples the WS handlers from a possibly
  //   non-stable `onConnectionStateChange` prop → no stale closure even
  //   if the parent passes a new function on every render.
  const stateRef = useRef<TerminalState>('connecting');
  const onStateChangeRef = useRef<typeof onConnectionStateChange>(undefined);
  useEffect(() => {
    onStateChangeRef.current = onConnectionStateChange;
  }, [onConnectionStateChange]);

  // The token is a connect-time input only: the gateway verifies the JWT once
  // during the WS upgrade and never re-checks it, so a rotation mid-session is
  // irrelevant to an already-open socket. Holding it in a ref (instead of an
  // effect dep) is what keeps it that way — `useAuth` refreshes at
  // `expiry - 60s`, i.e. every 840s, and with `authToken` in the deps below
  // that refresh tore down the WS and disposed the xterm instance, handing the
  // user a blank new console mid-session. The audit log showed it plainly:
  // 17 of the last 40 `terminal_close` rows sat at 840.0s ± 1s, because after
  // the first forced remount every session starts in lockstep with the token.
  const authTokenRef = useRef(authToken);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  // Stable identity (only touches refs + setState which is stable) → safe to
  // include in effect deps and lets us drop the broad eslint-suppress.
  const notifyState = useCallback((next: TerminalState) => {
    stateRef.current = next;
    setState(next);
    onStateChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#000000',
        foreground: '#e5e7eb',
        cursor: '#a78bfa',
        cursorAccent: '#000000',
        selectionBackground: '#4c1d95',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // container may not have layout yet — initial-resize will re-try
    }
    termRef.current = term;
    fitRef.current = fit;

    setCloseInfo(null);
    notifyState('connecting');

    const ws = new WebSocket(buildWsUrl(connectionId, authTokenRef.current));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      notifyState('connected');
      try {
        fit.fit();
      } catch {
        // ignore — initial fit failure
      }
      const cols = term.cols;
      const rows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      term.focus();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // Control frame from the gateway. Today only 'exit' uses this path.
        const frame = parseControlFrame(ev.data);
        if (frame?.type === 'exit') {
          const code = frame.exitCode ?? '?';
          term.write(
            `\r\n\x1b[2m# ${t('ssh.terminal.exited')} (exit code ${code})\x1b[0m\r\n`,
          );
          notifyState('exited');
          return;
        }
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };

    ws.onerror = () => {
      // `onerror` always precedes `onclose` per WS spec — keep the state
      // transition for the `onclose` handler which has the actual code.
      term.write(
        `\r\n\x1b[31m# ${t('ssh.terminal.errorWriting')}\x1b[0m\r\n`,
      );
    };

    ws.onclose = (ev) => {
      const reason = describeCloseCode(ev.code, ev.reason, t);
      term.write(
        `\r\n\x1b[2m# ${t('ssh.terminal.disconnected')} — ${reason}\x1b[0m\r\n`,
      );
      setCloseInfo({ code: ev.code, reason });
      // Distinguish "shell exited cleanly" (already 'exited') from network/
      // auth termination so the header label and the Reconnect button can
      // react accordingly. WS application-error codes start at 4000+ and
      // 1011 = internal error → all treated as 'error'. 1000/1005/1006 =
      // normal/no-status → 'disconnected'.
      // Use `stateRef` (not a setState-updater) so we don't fire a
      // side-effect inside an updater — that would double-fire under
      // React StrictMode.
      if (stateRef.current === 'exited') return;
      const isError =
        (ev.code >= 4000 && ev.code <= 4999) || ev.code === 1011;
      notifyState(isError ? 'error' : 'disconnected');
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const sendResize = () => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }),
        );
      }
    };

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(container);
    window.addEventListener('resize', sendResize);

    return () => {
      window.removeEventListener('resize', sendResize);
      ro.disconnect();
      onData.dispose();
      try {
        ws.close();
      } catch {
        // noop
      }
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
    // `reconnectKey` triggers a full re-mount of the effect — that's how the
    // Reconnect button works (build a fresh WS + Terminal). `notifyState` is
    // referentially stable (empty-deps `useCallback`, all callees are refs),
    // so listing it here does not re-run the connect logic.
    // `authToken` deliberately stays OUT of these deps — see `authTokenRef`.
    // The Reconnect path still picks up the freshest token because it reads
    // the ref when it rebuilds the URL.
  }, [connectionId, reconnectKey, notifyState, t]);

  const handleDisconnect = () => {
    try {
      wsRef.current?.close();
    } catch {
      // noop
    }
    onClose?.();
  };

  const handleReconnect = () => {
    setReconnectKey((k) => k + 1);
  };

  const statusLabel = (() => {
    switch (state) {
      case 'connecting':
        return `⏳ ${t('ssh.terminal.statusConnecting')}`;
      case 'connected':
        return `🟢 ${t('ssh.terminal.statusConnected')}`;
      case 'exited':
        return `⚪ ${t('ssh.terminal.statusExited')}`;
      case 'disconnected':
        return `🔴 ${t('ssh.terminal.statusDisconnected')}`;
      case 'error':
        return `❌ ${closeInfo ? closeInfo.reason : t('ssh.terminal.statusError')}`;
    }
  })();

  const canReconnect = state === 'disconnected' || state === 'error' || state === 'exited';

  return (
    <div className="flex flex-col h-[80vh] min-h-[480px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 bg-gray-950">
        <div className="text-xs min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-200 truncate">{connectionLabel}</span>
            <span className="text-gray-600">·</span>
            <span className="font-mono text-gray-500 truncate">{hostInfo}</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">{statusLabel}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canReconnect && (
            <Button size="xs" variant="success" onClick={handleReconnect}>
              ↻ {t('ssh.terminal.reconnect')}
            </Button>
          )}
          <Button size="xs" variant="secondary" onClick={handleDisconnect}>
            {t('ssh.terminal.disconnect')}
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 bg-black px-2 py-1 overflow-hidden"
      />

      <div className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-800 bg-gray-950">
        {t('ssh.terminal.hint')}
      </div>
    </div>
  );
}
