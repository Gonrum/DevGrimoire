import { useTranslation } from 'react-i18next';
import type { ResearchTaskItem } from '../../api/client';
import type { LiveState } from '../../lib/research';
import Card from '../ui/Card';

function laneLabel(lane: string, tasks: ResearchTaskItem[], t: (k: string) => string): string {
  if (lane === 'main') return t('researchRun.detail.report');
  const n = Number(lane.replace(/^[a-z]+/, ''));
  const task = tasks.find((x) => x.n === n);
  return task ? `${lane} · ${task.question}` : lane;
}

export default function ResearchLiveLanes({ live, tasks }: { live: LiveState; tasks: ResearchTaskItem[] }) {
  const { t } = useTranslation();
  const lanes = Object.entries(live.lanes).filter(([, l]) => l.active || l.text || l.reasoning);
  if (lanes.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold flex items-center gap-2">
        {!live.ended && <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />}
        {t('researchRun.detail.live')}
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {lanes.map(([name, lane]) => (
          <Card key={name} padding="sm" className={lane.active ? 'border-cyan-800' : 'opacity-70'}>
            <div className="flex items-center justify-between gap-2 mb-1 text-xs">
              <span className="font-semibold truncate min-w-0">{laneLabel(name, tasks, t)}</span>
              {lane.model && <span className="text-gray-500 shrink-0">{lane.model}</span>}
            </div>
            {lane.busy && (
              <p className="text-xs text-yellow-300 mb-1">
                {t('researchRun.detail.waiting')} ({Object.entries(lane.busy).map(([k, v]) => `${k}: ${v}`).join(', ')})
              </p>
            )}
            {lane.reasoning && (
              <details className="mb-1">
                <summary className="text-xs text-gray-500 cursor-pointer">{t('researchRun.detail.reasoning')}</summary>
                <pre className="text-xs text-gray-500 whitespace-pre-wrap max-h-40 overflow-y-auto">{lane.reasoning.slice(-4000)}</pre>
              </details>
            )}
            <pre className="text-xs text-gray-300 whitespace-pre-wrap max-h-56 overflow-y-auto">{lane.text.slice(-6000)}</pre>
          </Card>
        ))}
      </div>
    </section>
  );
}
