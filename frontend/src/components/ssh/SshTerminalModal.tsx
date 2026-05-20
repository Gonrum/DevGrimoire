import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SshConnectionListItem } from '../../api/client';
import { Portal } from '../ui/Dialog';
import SshTerminal, { TerminalState } from './SshTerminal';

export interface SshTerminalModalProps {
  open: boolean;
  onClose: () => void;
  connection: SshConnectionListItem;
  authToken: string | null;
}

/**
 * Full-screen overlay hosting `<SshTerminal>` (Spec §5.6).
 *
 * Esc / backdrop-click semantics:
 *   - When the underlying WS is `connected`, intercept the close and require
 *     an explicit confirm — otherwise users lose a live shell on a stray
 *     Esc-keystroke (vim, less, …).
 *   - When the session is already `disconnected` / `exited` / `error`, close
 *     immediately — no live work to protect.
 */
export default function SshTerminalModal({
  open,
  onClose,
  connection,
  authToken,
}: SshTerminalModalProps) {
  const { t } = useTranslation();
  const [termState, setTermState] = useState<TerminalState>('connecting');
  const stateRef = useRef<TerminalState>('connecting');

  useEffect(() => {
    stateRef.current = termState;
  }, [termState]);

  // The confirm-dialog is rendered as a thin in-modal layer rather than as a
  // browser `confirm()` so it survives focus quirks inside xterm.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const requestClose = useCallback(() => {
    if (stateRef.current === 'connected') {
      setConfirmOpen(true);
      return;
    }
    onClose();
  }, [onClose]);

  // ESC handling: capture before xterm sees the keystroke. xterm forwards Esc
  // into the shell as `\x1b`, which is fine — we only act when the modal is
  // actually open. We use `keydown` on `window` so it works regardless of
  // which child has focus.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        // Don't preempt Esc while a confirm is showing — that lets users
        // cancel the confirm with a second Esc press.
        if (confirmOpen) return;
        // Capture phase ensures we run before xterm; but xterm runs on
        // `keydown` too, so we just prevent the default + stop propagation
        // when we're about to do something the user can see.
        if (stateRef.current === 'connected') {
          ev.preventDefault();
          ev.stopPropagation();
          setConfirmOpen(true);
        } else {
          ev.preventDefault();
          ev.stopPropagation();
          onClose();
        }
      }
    };
    // Capture-phase so we run before xterm's handler (which is on the
    // container element). Without capture xterm would already have sent
    // ESC to the shell by the time we react.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, confirmOpen, onClose]);

  const handleBackdropClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    // Only react to direct clicks on the backdrop layer, not bubbled events
    // from the inner card.
    if (ev.target === ev.currentTarget) {
      requestClose();
    }
  };

  if (!open) return null;

  const hostInfo = `${connection.username}@${connection.host}:${connection.port}`;

  return (
    <Portal>
      <div
        className="absolute inset-0 flex items-center justify-center"
        onMouseDown={handleBackdropClick}
      >
        <div
          className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 w-[95vw] max-w-6xl overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-violet-500/10 border-b border-violet-500/30 px-5 py-3 flex items-center justify-between">
            <span className="text-sm font-medium text-violet-300">
              ⚡ {t('ssh.terminal.modalTitle', { label: connection.label })}
            </span>
            <button
              onClick={requestClose}
              className="text-gray-500 hover:text-gray-300"
              aria-label={t('common.close')}
            >
              &times;
            </button>
          </div>
          <SshTerminal
            connectionId={connection.id}
            connectionLabel={connection.label}
            hostInfo={hostInfo}
            authToken={authToken}
            onClose={requestClose}
            onConnectionStateChange={setTermState}
          />
        </div>

        {confirmOpen && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/60"
            onMouseDown={(e) => {
              // Don't propagate to the outer backdrop handler.
              e.stopPropagation();
            }}
          >
            <div className="bg-gray-900 border border-red-500/50 rounded-xl shadow-2xl max-w-md w-full mx-4 p-5">
              <div className="text-sm font-medium text-red-300 mb-2">
                {t('ssh.terminal.confirmCloseTitle')}
              </div>
              <div className="text-xs text-gray-400 mb-4">
                {t('ssh.terminal.confirmCloseBody')}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
                  onClick={() => setConfirmOpen(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500"
                  onClick={() => {
                    setConfirmOpen(false);
                    onClose();
                  }}
                >
                  {t('ssh.terminal.confirmCloseConfirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Portal>
  );
}
