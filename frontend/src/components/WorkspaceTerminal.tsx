import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { Workspace, getCurrentAccessToken } from '../api/client';
import { safeRandomUUID } from '../utils/randomId';
import Button from './ui/Button';

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

const BASE_URL =
  (typeof window !== 'undefined' && (window as unknown as { __DG_API_URL__?: string }).__DG_API_URL__) ||
  '/api';

// Session id for the per-tab terminal map key on the sidecar. Uses the
// secure-context-safe UUID helper so it also works over plain HTTP, where
// crypto.randomUUID is undefined.
const makeSessionId = safeRandomUUID;

function buildWsUrl(workspaceId: string, sessionId: string): string {
  const token = getCurrentAccessToken();
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const apiPath = BASE_URL.startsWith('http')
    ? BASE_URL.replace(/^http/i, proto)
    : `${proto}://${window.location.host}${BASE_URL}`;
  const url = new URL(`${apiPath}/workspaces/${workspaceId}/terminal`);
  url.searchParams.set('token', token || '');
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export default function WorkspaceTerminal({ workspace, onClose }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Persistent session id per Browser-tab+workspace mount so a brief
    // network hiccup re-attaches to the same bash on the sidecar.
    const sessionId = makeSessionId();
    const ws = new WebSocket(buildWsUrl(workspace._id, sessionId));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      // Push initial size so bash knows the viewport.
      const cols = term.cols;
      const rows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // Control frame from the proxy — display structured info but stay
        // out of the agent's way (avoid weird ANSI). Only 'exit' messages
        // come through this path today.
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === 'exit') {
            term.write(`\r\n\x1b[2m# bash exited (code ${msg.exitCode ?? '?'})\x1b[0m\r\n`);
            return;
          }
        } catch {
          // not JSON — fall through and write as text
        }
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };
    ws.onerror = () => {
      term.write(`\r\n\x1b[31m# connection error — close and reopen the terminal to reconnect\x1b[0m\r\n`);
    };
    ws.onclose = (ev) => {
      term.write(`\r\n\x1b[2m# connection closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})\x1b[0m\r\n`);
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const sendResize = () => {
      if (!fitRef.current || !termRef.current) return;
      try { fitRef.current.fit(); } catch { /* container detached */ return; }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
      }
    };
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(container);
    window.addEventListener('resize', sendResize);

    term.focus();

    return () => {
      window.removeEventListener('resize', sendResize);
      ro.disconnect();
      onData.dispose();
      try { ws.close(); } catch { /* noop */ }
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [workspace._id]);

  return (
    <div className="flex flex-col h-[70vh] min-h-[420px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="text-xs">
          <span className="text-gray-500">{t('terminal.workspace')}: </span>
          <span className="font-mono text-gray-200">{workspace.name}</span>
          <span className="text-gray-600 mx-2">·</span>
          <span className="font-mono text-gray-500">{workspace.path}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 bg-black px-2 py-1 overflow-hidden"
      />

      <div className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-800 bg-gray-950">
        {t('terminal.ptyHint')}
      </div>
    </div>
  );
}
