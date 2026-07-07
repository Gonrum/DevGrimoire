import type { Tab } from '../tabs';

export interface StatItem {
  key: string;
  label: string;
  value: number | string;
  tab: Tab;
}

interface Props {
  stats: StatItem[];
  onNavigate: (tab: Tab) => void;
}

export default function OverviewStatRow({ stats, onNavigate }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {stats.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onNavigate(s.tab)}
          className="text-left bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-violet-500 transition-colors"
        >
          <div className="text-2xl font-bold text-gray-100">{s.value}</div>
          <div className="text-xs text-gray-500 mt-1 truncate">{s.label}</div>
        </button>
      ))}
    </div>
  );
}
