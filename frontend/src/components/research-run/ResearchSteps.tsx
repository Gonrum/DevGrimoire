import { useTranslation } from 'react-i18next';
import type { ResearchStepItem } from '../../api/client';

const KIND_COLORS: Record<ResearchStepItem['kind'], string> = {
  info: 'text-gray-400',
  plan: 'text-violet-300',
  search: 'text-cyan-300',
  read: 'text-teal-300',
  skip: 'text-gray-600',
  write: 'text-green-300',
  error: 'text-red-400',
};

export default function ResearchSteps({ steps }: { steps: ResearchStepItem[] }) {
  const { t, i18n } = useTranslation();
  if (steps.length === 0) return <p className="text-sm text-gray-500">{t('researchRun.detail.noSteps')}</p>;
  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  return (
    <ol className="space-y-0.5 text-xs font-mono max-h-96 overflow-y-auto">
      {steps.map((s) => (
        <li key={s._id} className="flex gap-2">
          <span className="text-gray-600 shrink-0">{new Date(s.at).toLocaleTimeString(locale)}</span>
          {s.lane && <span className="text-gray-500 shrink-0">{s.lane}</span>}
          <span className={`${KIND_COLORS[s.kind]} break-words min-w-0`}>{s.text}</span>
        </li>
      ))}
    </ol>
  );
}
