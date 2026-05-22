import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, AiCompleteResult, AiSuggestion, Todo } from '../../api/client';
import Button from '../ui/Button';
import { Portal } from '../ui/Dialog';
import MarkdownEditor from '../MarkdownEditor';
import { useToast } from '../Toast';

interface Props {
  open: boolean;
  milestoneId: string;
  onClose: () => void;
  onApplied: () => void;
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.75 ? 'bg-green-500' :
    confidence >= 0.5 ? 'bg-yellow-500' :
    'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 min-w-[60px]">
      <div className="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
        <div className={`h-1.5 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-7 text-right shrink-0">{pct}%</span>
    </div>
  );
}

interface SuggestionRowProps {
  suggestion: AiSuggestion;
  checked: boolean;
  onToggle: () => void;
}

function SuggestionRow({ suggestion, checked, onToggle }: SuggestionRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-800/30">
      <td className="py-2 px-2 w-8">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="accent-violet-500"
        />
      </td>
      <td className="py-2 px-2 text-xs text-gray-300">
        {suggestion.displayNumber && (
          <span className="text-gray-600 mr-1">{suggestion.displayNumber}</span>
        )}
        {suggestion.title}
      </td>
      <td className="py-2 px-2 text-xs whitespace-nowrap">
        <span className="text-gray-500">{suggestion.currentStatus}</span>
        <span className="text-gray-600 mx-1">→</span>
        <span className="text-violet-400 font-medium">{suggestion.suggestedStatus}</span>
      </td>
      <td className="py-2 px-2">
        <ConfidenceBar confidence={suggestion.confidence} />
      </td>
      <td className="py-2 px-2 text-xs text-gray-400 max-w-[200px]">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-left text-gray-500 hover:text-gray-300 transition-colors"
          title={t('milestone.ai.reason')}
        >
          {expanded ? (
            <span>{suggestion.reason}</span>
          ) : (
            <span className="truncate block max-w-[180px]">{suggestion.reason}</span>
          )}
        </button>
      </td>
    </tr>
  );
}

export default function MilestoneAiCompleteDialog({ open, milestoneId, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast() as { showError: (msg: string) => void; showSuccess: (msg: string) => void };

  const [summary, setSummary] = useState('');
  const [result, setResult] = useState<AiCompleteResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  if (!open) return null;

  const handleGenerate = async () => {
    if (!summary.trim()) return;
    setLoading(true);
    try {
      const res = await api.milestones.aiComplete(milestoneId, summary);
      setResult(res);
      // Pre-select suggestions where status actually changes
      const preSelected = new Set(
        res.suggestions
          .filter((s) => s.suggestedStatus !== s.currentStatus)
          .map((s) => s.todoId)
      );
      setSelected(preSelected);
    } catch (err: any) {
      showError(err.message || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    if (!result) return;
    setApplying(true);
    const toApply = result.suggestions.filter((s) => selected.has(s.todoId));
    let successCount = 0;
    const errors: string[] = [];

    for (const suggestion of toApply) {
      try {
        await api.todos.update(suggestion.todoId, { status: suggestion.suggestedStatus as Todo['status'] });
        successCount++;
      } catch (err: any) {
        errors.push(`${suggestion.title}: ${err.message}`);
      }
    }

    setApplying(false);

    if (errors.length > 0) {
      showError(`${successCount} ${t('common.applied', 'angewendet')}, ${errors.length} ${t('common.errors', 'Fehler')}: ${errors[0]}`);
    } else {
      showSuccess(`${successCount} ${t('common.applied', 'Status-Updates angewendet')}`);
    }

    onApplied();
    handleClose();
  };

  const handleClose = () => {
    setSummary('');
    setResult(null);
    setSelected(new Set());
    onClose();
  };

  const toggleAll = () => {
    if (!result) return;
    if (selected.size === result.suggestions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(result.suggestions.map((s) => s.todoId)));
    }
  };

  return (
    <Portal>
      <div className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 max-w-3xl w-full mx-4 overflow-hidden">
        <div className="bg-violet-500/10 border-b border-violet-500/30 px-5 py-3 flex items-center justify-between">
          <span className="text-sm font-medium text-violet-300">{t('milestone.actions.aiComplete')}</span>
          <button onClick={handleClose} className="text-gray-500 hover:text-gray-300">&times;</button>
        </div>
        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {!result ? (
            /* Step 1: Summary input */
            <>
              <p className="text-xs text-gray-400">{t('milestone.ai.summaryPrompt')}</p>
              <MarkdownEditor
                value={summary}
                onChange={setSummary}
                rows={6}
                placeholder={t('milestone.ai.summaryPrompt')}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleGenerate}
                  disabled={!summary.trim() || loading}
                >
                  {loading ? t('common.loading', 'Generiere...') : t('milestone.ai.generate')}
                </Button>
                <Button type="button" onClick={handleClose}>{t('common.cancel')}</Button>
              </div>
            </>
          ) : (
            /* Step 2: Suggestions table */
            <>
              {/* Info row */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 bg-gray-800/30 rounded px-3 py-2">
                {result.modelUsed && (
                  <span>Model: <span className="text-gray-300">{result.modelUsed}</span></span>
                )}
                <span>{result.suggestions.length} {t('milestone.ai.suggestions', 'Vorschläge')}</span>
                {result.warnings && result.warnings.length > 0 && (
                  <span className="text-yellow-500">{result.warnings.join(', ')}</span>
                )}
              </div>

              {result.suggestions.length === 0 ? (
                <p className="text-sm text-gray-500 italic">{t('milestone.ai.noSuggestions', 'Keine Vorschläge.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-gray-800">
                        <th className="py-1.5 px-2 w-8">
                          <input
                            type="checkbox"
                            checked={selected.size === result.suggestions.length && result.suggestions.length > 0}
                            onChange={toggleAll}
                            className="accent-violet-500"
                          />
                        </th>
                        <th className="py-1.5 px-2">{t('common.title', 'Titel')}</th>
                        <th className="py-1.5 px-2">{t('common.status', 'Status')}</th>
                        <th className="py-1.5 px-2">{t('milestone.ai.confidence')}</th>
                        <th className="py-1.5 px-2">{t('milestone.ai.reason')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.suggestions.map((s) => (
                        <SuggestionRow
                          key={s.todoId}
                          suggestion={s}
                          checked={selected.has(s.todoId)}
                          onToggle={() => {
                            const next = new Set(selected);
                            if (next.has(s.todoId)) next.delete(s.todoId);
                            else next.add(s.todoId);
                            setSelected(next);
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleApply}
                  disabled={selected.size === 0 || applying}
                >
                  {applying
                    ? t('common.saving')
                    : `${t('milestone.ai.applySelected')} (${selected.size})`
                  }
                </Button>
                <Button type="button" onClick={() => setResult(null)}>{t('common.back', 'Zurück')}</Button>
                <Button type="button" onClick={handleClose}>{t('common.cancel')}</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
