import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { RemoteIssue } from './parseValidationIssues';

interface Props {
  issues: RemoteIssue[];
  onJumpTo: (nodeId: string) => void;
  onDismiss: () => void;
}

export function WorkflowValidationBanner({ issues, onJumpTo, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return null;

  return (
    <div className="sticky bottom-0 z-30 border-t border-amber-700 bg-gradient-to-r from-amber-900/40 to-red-900/30 shadow-lg">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm text-amber-200 hover:text-amber-100"
        >
          <AlertTriangle size={14} />
          <span>{issues.length} Validierungsfehler</span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-200"
        >Schließen</button>
      </div>
      {open && (
        <ul className="max-h-48 overflow-y-auto border-t border-amber-800 px-4 py-2 text-xs">
          {issues.map((issue, idx) => (
            <li key={idx} className="py-1">
              {issue.nodeId ? (
                <button
                  type="button"
                  onClick={() => onJumpTo(issue.nodeId!)}
                  className="font-mono text-cyan-300 hover:underline"
                >node "{issue.nodeId}"</button>
              ) : null}
              {issue.nodeType ? <span className="ml-2 text-gray-500">({issue.nodeType})</span> : null}
              <span className="ml-2 text-amber-200">{issue.message ?? issue.rawMessage}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
