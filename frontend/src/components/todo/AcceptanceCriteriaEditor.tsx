import { useTranslation } from 'react-i18next';
import { AcceptanceCriterion } from '../../api/client';
import Button from '../ui/Button';

interface Props {
  value: AcceptanceCriterion[];
  onChange: (value: AcceptanceCriterion[]) => void;
}

/**
 * Die Liste hatte einen State mit einer UUID pro Kriterium, nur um daraus
 * React-Keys zu bauen — abgeleiteter Zustand, der sich bei jeder externen
 * Längenänderung (Todo-Reload) **komplett** neu würfelte: alle Inputs wurden
 * dabei neu gemountet und der Fokus/IME-Zustand ging mitten im Tippen verloren.
 *
 * `AcceptanceCriterion` hat keine eigene ID, und die Liste kennt kein Sortieren
 * oder Verschieben — nur Anhängen, Löschen und Editieren. Der Index ist damit
 * die stabile Identität: die Inputs sind vollständig kontrolliert (`value=`) und
 * halten keinen eigenen State, den ein Index-Key durcheinanderbringen könnte.
 */
export default function AcceptanceCriteriaEditor({ value, onChange }: Props) {
  const { t } = useTranslation();

  const add = () => {
    onChange([...value, { text: '', done: false }]);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const toggle = (index: number) => {
    onChange(value.map((c, i) => (i === index ? { ...c, done: !c.done } : c)));
  };

  const updateText = (index: number, text: string) => {
    onChange(value.map((c, i) => (i === index ? { ...c, text } : c)));
  };

  if (value.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-600 italic">{t('todoDetail.acceptanceCriteriaEmpty')}</p>
        <Button type="button" size="sm" variant="secondary" onClick={add}>
          {t('todoDetail.addCriterion')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {value.map((criterion, index) => (
        <div key={index} className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => toggle(index)}
            className={`mt-1 w-4 h-4 shrink-0 rounded border transition-colors ${
              criterion.done
                ? 'bg-green-600 border-green-500'
                : 'bg-gray-900 border-gray-600 hover:border-gray-400'
            }`}
            aria-label={criterion.done ? t('todoDetail.acceptanceCriteria.markIncomplete') : t('todoDetail.acceptanceCriteria.markComplete')}
          >
            {criterion.done && (
              <svg className="w-4 h-4 text-white" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <input
            type="text"
            value={criterion.text}
            onChange={(e) => updateText(index, e.target.value)}
            placeholder={t('todoDetail.criterionPlaceholder')}
            className={`flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500 transition-colors ${
              criterion.done ? 'text-gray-500 line-through' : 'text-gray-200'
            }`}
          />
          <button
            type="button"
            onClick={() => remove(index)}
            className="mt-1 text-gray-600 hover:text-red-400 transition-colors shrink-0"
            aria-label={t('todoDetail.acceptanceCriteria.removeAria')}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" onClick={add} className="mt-1">
        {t('todoDetail.addCriterion')}
      </Button>
    </div>
  );
}
