import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { getCurrentAccessToken } from '../api/client';
import SshTerminal from '../components/ssh/SshTerminal';
import { safeRandomUUID } from '../utils/randomId';
import { useIdeStore } from './ide-store';

interface TabProps {
  workspaceId: string;
  label: string;
  active: boolean;
  initialInput?: string;
  onInputSent: () => void;
  onClose: () => void;
}

function TerminalTab({ workspaceId, label, active, initialInput, onInputSent, onClose }: TabProps) {
  const { t } = useTranslation();
  // The id keys the sidecar's PTY; it lives as long as this tab component does.
  const [sessionId] = useState(() => `ide-${safeRandomUUID()}`);
  const [closedEarly, setClosedEarly] = useState(false);

  return (
    <div
      role="tabpanel"
      className={`absolute inset-0 flex flex-col ${active ? '' : 'invisible pointer-events-none'}`}
    >
      {closedEarly && (
        <div className="shrink-0 border-b border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-yellow-400">
          {t('ide.terminalConnectFailed')}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <SshTerminal
          target={{ kind: 'workspace', workspaceId, sessionId }}
          connectionLabel={label}
          hostInfo={t('ide.terminalHost')}
          authToken={getCurrentAccessToken()}
          active={active}
          hint={t('ide.terminalHint')}
          heightClassName="h-full"
          initialInput={initialInput}
          onInitialInputSent={onInputSent}
          onClose={onClose}
          onClosedBeforeOpen={() => setClosedEarly(true)}
          onConnectionStateChange={(state) => {
            if (state === 'connecting' || state === 'connected') setClosedEarly(false);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Terminal tabs under the editor. Hidden tabs (and the whole panel while collapsed) stay
 * mounted, so their sessions keep running; only closing a tab disconnects it.
 */
export function TerminalPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const open = useIdeStore((s) => s.terminalOpen);
  const terminals = useIdeStore((s) => s.terminals);
  const activeTerminal = useIdeStore((s) => s.activeTerminal);
  const terminalInputs = useIdeStore((s) => s.terminalInputs);
  const addTerminal = useIdeStore((s) => s.addTerminal);
  const closeTerminal = useIdeStore((s) => s.closeTerminal);
  const clearTerminalInput = useIdeStore((s) => s.clearTerminalInput);
  const setActiveTerminal = useIdeStore((s) => s.setActiveTerminal);

  // Opening the panel with no tab yet starts one.
  useEffect(() => {
    if (open && useIdeStore.getState().terminals.length === 0) addTerminal();
  }, [open, terminals.length, addTerminal]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-900" data-ide-terminal="">
      <div role="tablist" className="flex h-8 shrink-0 items-center gap-1 border-b border-gray-700 bg-gray-800 px-2 text-xs">
        {terminals.map((id, index) => (
          <div
            key={id}
            className={`flex items-center gap-1 rounded-sm px-2 py-1 ${
              id === activeTerminal ? 'bg-gray-900 text-cyan-400' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <button type="button" role="tab" aria-selected={id === activeTerminal} onClick={() => setActiveTerminal(id)}>
              {t('ide.terminalTab', { n: index + 1 })}
            </button>
            <button
              type="button"
              aria-label={t('ide.terminalClose')}
              title={t('ide.terminalClose')}
              className="text-gray-500 hover:text-gray-200"
              onClick={() => closeTerminal(id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label={t('ide.terminalNew')}
          title={t('ide.terminalNew')}
          className="rounded-sm p-1 text-gray-400 hover:bg-gray-900 hover:text-gray-200"
          onClick={() => addTerminal()}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {terminals.map((id, index) => (
          <TerminalTab
            key={id}
            workspaceId={workspaceId}
            label={t('ide.terminalTab', { n: index + 1 })}
            active={open && id === activeTerminal}
            initialInput={terminalInputs[id]}
            onInputSent={() => clearTerminalInput(id)}
            onClose={() => closeTerminal(id)}
          />
        ))}
      </div>
    </div>
  );
}
