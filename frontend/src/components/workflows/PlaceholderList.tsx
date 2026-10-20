import { useTranslation } from 'react-i18next';
import { groupByField, placeholderTone, type PlaceholderTone, type PlaceholderTrace } from '../../lib/placeholder-view';

// Statische Klassen (Tailwind erkennt keine zusammengesetzten Namen).
const TONE_CLASS: Record<PlaceholderTone, string> = {
  ok: 'text-green-300',
  muted: 'text-gray-500',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

/**
 * Platzhalter-Spuren je Config-Feld, eingefärbt nach Status. Gemeinsam für
 * Lauf-Inspektor/Debug-Panel (NodeRunTriple) und die Modal-Vorschau.
 */
export function PlaceholderList({ traces }: { traces: PlaceholderTrace[] }) {
  const { t } = useTranslation();
  const groups = groupByField(traces);
  if (groups.length === 0) return null;
  return (
    <div className="mt-2" data-testid="placeholder-list">
      <h5 className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">{t('workflows.triple.placeholders')}</h5>
      {groups.map((g) => (
        <div key={g.field} className="mb-1.5">
          <div className="font-mono text-[11px] text-gray-400">{g.field}</div>
          <ul className="ml-2 space-y-0.5">
            {g.traces.map((tr, i) => (
              <li key={i} className="text-[11px]">
                <span className="text-gray-500">{t('workflows.triple.lineShort', { line: tr.line })}</span>{' '}
                <code className="text-cyan-300">{tr.raw ? `{{{${tr.expr}}}}` : `{{${tr.expr}}}`}</code>{' '}
                <span className={TONE_CLASS[placeholderTone(tr.status)]}>
                  {t(`workflows.triple.status.${tr.status}`)}
                </span>
                {tr.preview !== undefined && tr.preview !== '' && (
                  <span className="ml-1 font-mono text-gray-300">{tr.preview}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
