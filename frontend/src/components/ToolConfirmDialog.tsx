import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewText, previewTodos } from '../lib/toolPreview';
import Button from './ui/Button';
import { Dialog, Portal } from './ui/Dialog';

/**
 * Bestätigung vor der Ausführung eines schreibenden Chat-Tools (T-415).
 *
 * Der Anlass: der Briefing-Agent ruft `milestone_create_with_todos`, und die
 * Anwendung führte das sofort aus — ein Modell, das die Absicht falsch
 * versteht, legte damit ohne Rückfrage einen Milestone samt beliebig vielen
 * Todos an.
 *
 * **Alles hier liest ungeprüfte Modell-Ausgabe.** Die Argumente stammen aus
 * einem `JSON.parse` über einen vom LLM erzeugten String; jedes Feld kann
 * fehlen, leer oder vom falschen Typ sein. Die Vorschau darf daran nicht
 * scheitern — sonst blockiert ein kaputter Vorschlag den ganzen Chat, statt
 * nur abgelehnt zu werden. Deshalb durchgehend Prädikate statt Behauptungen
 * und überall ein Rückfall.
 */

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  onConfirm: () => void;
  onCancel: () => void;
}

/*
 * Feste Zuordnung statt zusammengebauter Klassennamen: Tailwind behält beim
 * Build nur, was wörtlich im Quelltext steht.
 */
const PRIORITY_BADGE: Record<string, string> = {
  low: 'bg-gray-800 border-gray-700 text-gray-400',
  medium: 'bg-blue-900/40 border-blue-700 text-blue-300',
  high: 'bg-amber-900/40 border-amber-700 text-amber-300',
  critical: 'bg-red-900/40 border-red-700 text-red-300',
};
const PRIORITY_BADGE_FALLBACK = 'bg-gray-800 border-gray-700 text-gray-400';

export default function ToolConfirmDialog({ toolName, args, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<number | null>(null);

  const isMilestoneBundle = toolName === 'milestone_create_with_todos';
  const todos = isMilestoneBundle ? previewTodos(args.todos) : [];

  return (
    <Portal>
      <Dialog title={t('chat.toolConfirm.title')} onClose={onCancel}>
        <div className="p-4">
          <p className="text-sm text-gray-400">
            {t('chat.toolConfirm.subtitle', { tool: toolName })}
          </p>

          <div className="mt-3 max-h-[55vh] overflow-y-auto">
            {isMilestoneBundle ? (
              <div className="space-y-3">
                <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-500">{t('chat.toolConfirm.milestone')}</p>
                  <p className="text-gray-200 font-medium break-words">
                    {previewText(args.name) ?? t('chat.toolConfirm.noName')}
                  </p>
                  {previewText(args.description) && (
                    <p className="text-sm text-gray-400 mt-1 whitespace-pre-wrap break-words">
                      {previewText(args.description)}
                    </p>
                  )}
                </div>

                <p className="text-sm text-gray-400">
                  {t('chat.toolConfirm.todoCount', { count: todos.length })}
                </p>

                {todos.map((todo, i) => (
                  <div key={i} className="bg-gray-950 border border-gray-800 rounded-lg">
                    <button
                      type="button"
                      className="w-full text-left p-3 flex flex-wrap items-start justify-between gap-2"
                      onClick={() => setExpanded(expanded === i ? null : i)}
                    >
                      <span className="min-w-0 break-words text-sm text-gray-200">
                        {todo.title || (
                          <em className="text-red-400">{t('chat.toolConfirm.noTitle')}</em>
                        )}
                      </span>
                      <span className="flex flex-wrap items-center gap-1 shrink-0">
                        {todo.priority && (
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[11px] ${
                              PRIORITY_BADGE[todo.priority] ?? PRIORITY_BADGE_FALLBACK
                            }`}
                          >
                            {todo.priority}
                          </span>
                        )}
                        {todo.tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-[11px] text-gray-400"
                          >
                            {tag}
                          </span>
                        ))}
                        <span className="text-gray-600 text-xs">{expanded === i ? '▾' : '▸'}</span>
                      </span>
                    </button>

                    {expanded === i && (
                      <div className="px-3 pb-3 space-y-2 text-sm">
                        <Field label={t('chat.toolConfirm.description')} value={todo.description} />
                        <Field label={t('chat.toolConfirm.userStories')} value={todo.userStories} />
                        {todo.acceptanceCriteria.length > 0 && (
                          <div>
                            <p className="text-xs text-gray-500">
                              {t('chat.toolConfirm.acceptance')}
                            </p>
                            <ul className="list-disc list-inside text-gray-300">
                              {todo.acceptanceCriteria.map((c, ci) => (
                                <li key={ci} className="break-words">
                                  {c}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <Field label={t('chat.toolConfirm.outOfScope')} value={todo.outOfScope} />
                        <Field label={t('chat.toolConfirm.edgeCases')} value={todo.edgeCases} />
                        {!todo.description &&
                          !todo.userStories &&
                          todo.acceptanceCriteria.length === 0 &&
                          !todo.outOfScope &&
                          !todo.edgeCases && (
                            <p className="text-gray-600 italic">{t('chat.toolConfirm.noDetail')}</p>
                          )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              /*
               * Allgemeiner Fall: die Argumente lesbar aufbereitet, damit der
               * Schutz für JEDES schreibende Tool gilt und nicht nur für das
               * eine, das den Anlass gab.
               */
              <pre className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            <Button variant="primary" size="sm" onClick={onConfirm}>
              {t('chat.toolConfirm.confirm')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              {t('chat.toolConfirm.cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Portal>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-gray-300 whitespace-pre-wrap break-words">{value}</p>
    </div>
  );
}
