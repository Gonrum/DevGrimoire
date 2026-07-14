import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Stack, StackEntry } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { downloadTextFile } from '../lib/download';

export default function StackDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [stack, setStack] = useState<Stack | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.stacks.get(id);
      setStack(s);
      setName(s.name);
      setDescription(s.description ?? '');
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const saveMeta = async () => {
    try {
      const s = await api.stacks.update(id, { name: name.trim(), description: description.trim() || undefined });
      setStack(s);
      showSuccess(t('stacks.saved'));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const addSection = async () => {
    try {
      setStack(await api.stacks.addEntry(id, { title: t('stacks.newSectionTitle'), content: '' }));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveSection = async (entry: StackEntry) => {
    try {
      const s = await api.stacks.updateEntry(id, entry._id, { title: entry.title, content: entry.content });
      setStack(s);
      showSuccess(t('stacks.saved'));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSection = async (entryId: string) => {
    if (!window.confirm(t('stacks.confirmDeleteSection'))) return;
    try {
      await api.stacks.removeEntry(id, entryId);
      setStack((prev) => (prev ? { ...prev, entries: prev.entries.filter((e) => e._id !== entryId) } : prev));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    if (!stack) return;
    const target = index + dir;
    if (target < 0 || target >= stack.entries.length) return;
    const entries = [...stack.entries];
    [entries[index], entries[target]] = [entries[target], entries[index]];
    try {
      setStack(await api.stacks.reorder(id, entries.map((e) => e._id)));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportStack = async (copy: boolean) => {
    try {
      const { text, filename } = await api.stacks.exportMarkdown(id);
      if (copy) { await navigator.clipboard.writeText(text); showSuccess(t('stacks.copied')); }
      else downloadTextFile(filename, text);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportSection = async (entryId: string, copy: boolean) => {
    try {
      const { text, filename } = await api.stacks.exportEntryMarkdown(id, entryId);
      if (copy) { await navigator.clipboard.writeText(text); showSuccess(t('stacks.copied')); }
      else downloadTextFile(filename, text);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateLocalEntry = (entryId: string, patch: Partial<StackEntry>) => {
    setStack((prev) =>
      prev ? { ...prev, entries: prev.entries.map((e) => (e._id === entryId ? { ...e, ...patch } : e)) } : prev,
    );
  };

  if (loading) return <LoadingText />;
  if (!stack) return null;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <button onClick={() => navigate('/stacks')} className="text-sm text-gray-400 hover:text-gray-200 mb-4">
        ← {t('stacks.backToList')}
      </button>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <FormInput label={t('stacks.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-3">
          <FormTextarea label={t('stacks.description')} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
        <div className="flex flex-wrap justify-between gap-2 mt-3">
          <Button variant="primary" onClick={saveMeta}>{t('common.save')}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => exportStack(false)}>⬇ {t('stacks.exportStack')}</Button>
            <Button variant="ghost" onClick={() => exportStack(true)}>⧉ {t('stacks.copy')}</Button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">{t('stacks.sections')}</h2>
        <Button variant="primary" onClick={addSection}>{t('stacks.addSection')}</Button>
      </div>

      <div className="space-y-4">
        {stack.entries.map((entry, index) => (
          <div key={entry._id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex flex-col">
                <button onClick={() => move(index, -1)} disabled={index === 0} className="text-gray-500 hover:text-gray-200 disabled:opacity-30">↑</button>
                <button onClick={() => move(index, 1)} disabled={index === stack.entries.length - 1} className="text-gray-500 hover:text-gray-200 disabled:opacity-30">↓</button>
              </div>
              <input
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100"
                value={entry.title}
                onChange={(e) => updateLocalEntry(entry._id, { title: e.target.value })}
              />
            </div>
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 font-mono text-sm"
              rows={8}
              value={entry.content}
              onChange={(e) => updateLocalEntry(entry._id, { content: e.target.value })}
            />
            <div className="flex flex-wrap justify-between gap-2 mt-2">
              <Button variant="primary" onClick={() => saveSection(entry)}>{t('common.save')}</Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => exportSection(entry._id, false)}>⬇ .md</Button>
                <Button variant="ghost" onClick={() => exportSection(entry._id, true)}>⧉ {t('stacks.copy')}</Button>
                <Button variant="danger" onClick={() => deleteSection(entry._id)}>🗑</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
