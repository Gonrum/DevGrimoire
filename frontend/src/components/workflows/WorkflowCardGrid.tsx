import { Link } from 'react-router-dom';
import { Workflow, Play } from 'lucide-react';
import { WorkflowDefinition } from '../../api/workflows';

interface Props {
  workflows: WorkflowDefinition[];
  onRun?: (id: string) => void;
}

export function WorkflowCardGrid({ workflows, onRun }: Props) {
  if (workflows.length === 0) {
    return <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-6 text-center text-sm text-gray-500">Keine Workflows.</div>;
  }
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
      {workflows.map((wf) => (
        <Link key={wf._id} to={`/workflows/${wf._id}`} className="block rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-cyan-600">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Workflow size={16} className="text-cyan-400" />
              <span className="font-medium text-gray-200">{wf.name}</span>
            </div>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${statusBadge(wf.status)}`}>{wf.status}</span>
          </div>
          <div className="text-xs text-gray-500">
            <div>Scope: {wf.scope} · v{wf.version}</div>
            <div>Trigger: {(wf.trigger as { type?: string })?.type ?? '—'}</div>
            {wf.lastRunAt && <div>Letzter Run: {new Date(wf.lastRunAt).toLocaleString()}</div>}
          </div>
          {onRun && wf.status === 'active' && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onRun(wf._id); }}
              className="mt-3 inline-flex items-center gap-1 rounded bg-cyan-900/40 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-900"
            >
              <Play size={12} /> ausführen
            </button>
          )}
        </Link>
      ))}
    </div>
  );
}

function statusBadge(s: string): string {
  if (s === 'active') return 'bg-green-900/40 text-green-300';
  if (s === 'paused') return 'bg-amber-900/40 text-amber-300';
  if (s === 'archived') return 'bg-gray-800 text-gray-500';
  return 'bg-gray-800 text-gray-300';
}
