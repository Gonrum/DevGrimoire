import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ResearchEntry, api } from '../api/client';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput } from './ui/FormField';
import { useToast } from './Toast';

interface FormData {
  title: string;
  content: string;
  sources: string[];
  tags: string;
}

const emptyForm = (): FormData => ({
  title: '',
  content: '',
  sources: [''],
  tags: '',
});

function fromEntry(entry: ResearchEntry): FormData {
  return {
    title: entry.title,
    content: entry.content,
    sources: entry.sources.length > 0 ? [...entry.sources] : [''],
    tags: entry.tags.join(', '),
  };
}

function ResearchForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: FormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<FormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<FormData>) => setForm((current) => ({ ...current, ...patch }));
  const updateSource = (i: number, value: string) =>
    update({ sources: form.sources.map((s, idx) => (idx === i ? value : s)) });
  const addSource = () => update({ sources: [...form.sources, ''] });
  const removeSource = (i: number) =>
    update({ sources: form.sources.length > 1 ? form.sources.filter((_, idx) => idx !== i) : [''] });

  const canSubmit = form.title.trim() && form.content.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const payload: Partial<ResearchEntry> = {
        title: form.title.trim(),
        content: form.content,
        sources: form.sources.map((s) => s.trim()).filter(Boolean),
        tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      };
      if (editId) {
        await api.research.update(editId, payload);
        showSuccess(t('research.updated'));
      } else {
        await api.research.create({ ...payload, projectId });
        showSuccess(t('research.created'));
      }
      onDone();
    } catch (err: any) {
      showError(err.message || t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <h3 className="text-sm font-semibold">
          {editId ? t('research.edit') : t('research.new')}
        </h3>
        <FormInput
          label={t('research.title')}
          required
          value={form.title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder={t('research.titlePlaceholder')}
          autoFocus
        />
        <FormInput
          label={t('common.tags')}
          value={form.tags}
          onChange={(e) => update({ tags: e.target.value })}
          placeholder={t('common.commaSeparated')}
        />
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t('research.sourcesLabel')}
          </label>
          <div className="space-y-2">
            {form.sources.map((source, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={source}
                  onChange={(e) => updateSource(i, e.target.value)}
                  placeholder={t('research.sourcePlaceholder')}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
                />
                <Button type="button" size="sm" variant="secondary" onClick={() => removeSource(i)} disabled={form.sources.length === 1 && !source}>
                  −
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <Button type="button" size="xs" onClick={addSource}>
              {t('research.addSource')}
            </Button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t('research.content')} *
          </label>
          <MarkdownEditor
            value={form.content}
            onChange={(content) => update({ content })}
            rows={12}
            placeholder={t('research.contentPlaceholder')}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="md" disabled={saving || !canSubmit}>
            {saving ? t('common.saving') : editId ? t('common.update') : t('common.create')}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function ResearchList({
  entries,
  projectId,
  onUpdate,
}: {
  entries: ResearchEntry[];
  projectId?: string;
  onUpdate?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ResearchEntry | null>(null);

  const editable = !!(projectId && onUpdate);

  const handleDelete = async (entry: ResearchEntry) => {
    try {
      await api.research.delete(entry._id);
      showSuccess(t('research.deleted'));
      onUpdate?.();
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  if (showForm && editable) {
    return (
      <ResearchForm
        initial={editing ? fromEntry(editing) : emptyForm()}
        editId={editing?._id}
        projectId={projectId!}
        onDone={() => { setShowForm(false); setEditing(null); onUpdate!(); }}
        onCancel={() => { setShowForm(false); setEditing(null); }}
      />
    );
  }

  return (
    <div>
      {editable && (
        <div className="mb-4">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => { setEditing(null); setShowForm(true); }}
          >
            {t('research.new')}
          </Button>
        </div>
      )}
      {entries.length === 0 ? (
        <EmptyState message={t('research.noResearch')} />
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <Card key={e._id}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-sm font-semibold truncate min-w-0">{e.title}</h3>
                <span className="text-xs text-gray-600 shrink-0">
                  {new Date(e.updatedAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US')}
                </span>
              </div>
              <Markdown className="text-gray-400">{e.content}</Markdown>
              {e.sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <p className="text-xs text-gray-500 mb-1">{t('research.sources')}</p>
                  <ul className="space-y-0.5">
                    {e.sources.map((src, i) => (
                      <li key={i} className="text-xs text-cyan-400 truncate">
                        {src.startsWith('http') ? (
                          <a href={src} target="_blank" rel="noopener noreferrer" className="hover:underline">{src}</a>
                        ) : (
                          src
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {e.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {e.tags.map((tag) => (
                    <Badge key={tag} color="bg-teal-900/40 text-teal-300">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              {editable && (
                <div className="flex gap-2 mt-4 pt-3 border-t border-gray-800">
                  <Button
                    size="xs"
                    onClick={() => { setEditing(e); setShowForm(true); }}
                  >
                    {t('common.edit')}
                  </Button>
                  <ConfirmButton
                    onConfirm={() => handleDelete(e)}
                    label={t('common.delete')}
                    confirmLabel={t('common.confirmDeleteLong')}
                    size="xs"
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
