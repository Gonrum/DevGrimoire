import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ImportResult, ParsedMilestone } from '../../api/client';
import Button from '../ui/Button';
import { Dialog, Portal } from '../ui/Dialog';
import { useToast } from '../Toast';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

export default function MilestoneImportDialog({ open, projectId, onClose, onImported }: Props) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [markdown, setMarkdown] = useState('');
  const [parsed, setParsed] = useState<ParsedMilestone | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);

  if (!open) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setMarkdown(ev.target?.result as string ?? '');
    };
    reader.readAsText(file);
  };

  const handlePreview = async () => {
    if (!markdown.trim()) return;
    setLoadingPreview(true);
    try {
      const result = await api.milestones.importPreview(markdown);
      setParsed(result);
    } catch (err: any) {
      showError(err.message || t('common.error'));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleApply = async () => {
    if (!parsed) return;
    setApplying(true);
    try {
      const result = await api.milestones.importApply(projectId, parsed);
      onImported(result);
      handleClose();
    } catch (err: any) {
      showError(err.message || t('common.error'));
    } finally {
      setApplying(false);
    }
  };

  const handleClose = () => {
    setMarkdown('');
    setParsed(null);
    onClose();
  };

  return (
    <Portal>
      <Dialog title={t('milestone.actions.importMarkdown')} onClose={handleClose}>
        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {!parsed ? (
            /* Step 1: Input */
            <>
              <p className="text-xs text-gray-400">{t('milestone.import.pasteOrUpload')}</p>
              <div className="space-y-2">
                <textarea
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  rows={10}
                  placeholder="# Milestone Name&#10;&#10;## Description&#10;..."
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-none font-mono"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-violet-400 hover:text-violet-300 underline"
                  >
                    {t('common.uploadFile', 'Datei hochladen')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.txt"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  {markdown && (
                    <span className="text-xs text-gray-500">({markdown.length} {t('common.chars', 'Zeichen')})</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={handlePreview}
                  disabled={!markdown.trim() || loadingPreview}
                >
                  {loadingPreview ? t('common.loading', 'Lade...') : t('milestone.import.preview')}
                </Button>
                <Button type="button" onClick={handleClose}>{t('common.cancel')}</Button>
              </div>
            </>
          ) : (
            /* Step 2: Preview parsed structure */
            <>
              <p className="text-xs text-gray-400">{t('milestone.import.parsedAs')}:</p>
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-gray-200">{parsed.name}</p>
                  {parsed.description && (
                    <p className="text-xs text-gray-400 mt-1">{parsed.description}</p>
                  )}
                </div>
                {parsed.todos.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 mb-2">
                      {parsed.todos.length} {t('milestoneDetail.tasks')}:
                    </p>
                    <ul className="space-y-1">
                      {parsed.todos.map((todo, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                          <span className="text-gray-600 shrink-0">{i + 1}.</span>
                          <span>
                            <span className="font-medium">{todo.title}</span>
                            {todo.status && (
                              <span className="ml-2 text-gray-500">[{todo.status}]</span>
                            )}
                            {todo.priority && (
                              <span className="ml-1 text-gray-500">· {todo.priority}</span>
                            )}
                            {todo.tags && todo.tags.length > 0 && (
                              <span className="ml-1 text-gray-600">· {todo.tags.join(', ')}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleApply}
                  disabled={applying}
                >
                  {applying ? t('common.saving') : t('milestone.import.apply')}
                </Button>
                <Button type="button" onClick={() => setParsed(null)}>{t('common.back', 'Zurück')}</Button>
                <Button type="button" onClick={handleClose}>{t('common.cancel')}</Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </Portal>
  );
}
