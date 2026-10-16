import { useTranslation } from 'react-i18next';
import Badge from '../ui/Badge';
import type { ResearchStatus } from '../../lib/research';

// Vollständige Klassen-Strings: Tailwind findet dynamisch zusammengesetzte Namen nicht.
const COLORS: Record<ResearchStatus, string> = {
  queued: 'bg-gray-800 text-gray-300',
  running: 'bg-cyan-900/50 text-cyan-300',
  paused: 'bg-yellow-900/50 text-yellow-300',
  done: 'bg-green-900/50 text-green-300',
  failed: 'bg-red-900/50 text-red-300',
  cancelled: 'bg-gray-800 text-gray-500',
};

export default function ResearchStatusBadge({ status, position }: { status: ResearchStatus; position?: number }) {
  const { t } = useTranslation();
  return (
    <Badge color={COLORS[status]}>
      {t(`researchRun.status.${status}`)}
      {status === 'queued' && position !== undefined && ` · ${t('researchRun.position', { position })}`}
    </Badge>
  );
}
