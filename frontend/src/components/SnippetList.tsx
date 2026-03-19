import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Snippet, api } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormTextarea } from './ui/FormField';

interface SnippetFormData {
  title: string;
  language: string;
  code: string;
  description: string;
  category: string;
  fileName: string;
  tags: string;
}

const emptyForm = (): SnippetFormData => ({
  title: '', language: '', code: '', description: '',
  category: '', fileName: '', tags: '',
});

function fromSnippet(s: Snippet): SnippetFormData {
  return {
    title: s.title,
    language: s.language,
    code: s.code,
    description: s.description || '',
    category: s.category || '',
    fileName: s.fileName || '',
    tags: s.tags.join(', '),
  };
}

function SnippetForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: SnippetFormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<SnippetFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<SnippetFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.code.trim() || !form.language.trim()) return;

    setSaving(true);
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const data = {
        projectId,
        title: form.title.trim(),
        language: form.language.trim().toLowerCase(),
        code: form.code,
        description: form.description.trim() || undefined,
        category: form.category.trim() || undefined,
        fileName: form.fileName.trim() || undefined,
        tags,
      };

      if (editId) {
        await api.snippets.update(editId, data);
        showSuccess(t('snippets.snippetUpdated', { title: form.title }));
      } else {
        await api.snippets.create(data);
        showSuccess(t('snippets.snippetCreated', { title: form.title }));
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
        <h3 className="text-sm font-semibold mb-3">
          {editId ? t('snippets.editSnippet') : t('snippets.newSnippet')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('common.name')}
            required
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder={t('snippets.titlePlaceholder')}
          />
          <FormInput
            label={t('snippets.language')}
            required
            value={form.language}
            onChange={(e) => update({ language: e.target.value })}
            placeholder={t('snippets.languagePlaceholder')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('common.category')}
            value={form.category}
            onChange={(e) => update({ category: e.target.value })}
            placeholder={t('snippets.categoryPlaceholder')}
          />
          <FormInput
            label={t('snippets.fileName')}
            value={form.fileName}
            onChange={(e) => update({ fileName: e.target.value })}
            placeholder={t('snippets.fileNamePlaceholder')}
          />
        </div>
        <FormTextarea
          label="Code"
          required
          value={form.code}
          onChange={(e) => update({ code: e.target.value })}
          rows={12}
          className="font-mono text-sm"
          placeholder={t('snippets.codePlaceholder')}
        />
        <FormTextarea
          label={t('common.description')}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={3}
          placeholder={t('snippets.descriptionPlaceholder')}
        />
        <FormInput
          label={t('common.tags')}
          value={form.tags}
          onChange={(e) => update({ tags: e.target.value })}
          placeholder={t('common.commaSeparated')}
        />
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="md" disabled={saving}>
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

export default function SnippetList({ entries, projectId }: { entries: Snippet[]; projectId: string }) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const languages = useMemo(() => {
    const l = new Set<string>();
    entries.forEach((e) => l.add(e.language));
    return Array.from(l).sort();
  }, [entries]);

  const categories = useMemo(() => {
    const c = new Set<string>();
    entries.forEach((e) => { if (e.category) c.add(e.category); });
    return Array.from(c).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (selectedLanguage) result = result.filter((e) => e.language === selectedLanguage);
    if (selectedCategory) result = result.filter((e) => e.category === selectedCategory);
    return result;
  }, [entries, selectedLanguage, selectedCategory]);

  const handleDelete = async (snippet: Snippet) => {
    try {
      await api.snippets.delete(snippet._id);
      showSuccess(t('snippets.snippetDeleted', { title: snippet.title }));
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  const handleCopy = async (snippet: Snippet) => {
    try {
      await navigator.clipboard.writeText(snippet.code);
      setCopiedId(snippet._id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // fallback
    }
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingSnippet(null);
  };

  if (showForm) {
    return (
      <SnippetForm
        initial={editingSnippet ? fromSnippet(editingSnippet) : emptyForm()}
        editId={editingSnippet?._id}
        projectId={projectId}
        onDone={handleFormDone}
        onCancel={handleFormDone}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => { setEditingSnippet(null); setShowForm(true); }}
          className="px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors"
        >
          {t('snippets.newSnippet')}
        </button>
        {languages.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedLanguage(null)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedLanguage === null
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('common.all')} ({entries.length})
            </button>
            {languages.map((l) => (
              <button
                key={l}
                onClick={() => setSelectedLanguage(selectedLanguage === l ? null : l)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedLanguage === l
                    ? 'bg-cyan-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {l} ({entries.filter((e) => e.language === l).length})
              </button>
            ))}
          </div>
        )}
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setSelectedCategory(selectedCategory === c ? null : c)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedCategory === c
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState message={t('snippets.noSnippets')} />
      ) : filtered.length === 0 ? (
        <EmptyState message={t('snippets.noFiltered')} />
      ) : (
        <div className="space-y-2">
          {filtered.map((snippet) => (
            <Card key={snippet._id}>
              <div
                className="cursor-pointer"
                onClick={() => setExpandedId(expandedId === snippet._id ? null : snippet._id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold">{snippet.title}</h3>
                    <Badge color="bg-cyan-900/40 text-cyan-300">{snippet.language}</Badge>
                    {snippet.category && (
                      <Badge color="bg-purple-900/40 text-purple-300">{snippet.category}</Badge>
                    )}
                    {snippet.fileName && (
                      <span className="text-xs font-mono text-gray-500">{snippet.fileName}</span>
                    )}
                  </div>
                  <span className="text-gray-600 text-xs">{expandedId === snippet._id ? '\u25B2' : '\u25BC'}</span>
                </div>
              </div>

              {expandedId === snippet._id && (
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
                  {snippet.description && (
                    <p className="text-sm text-gray-400">{snippet.description}</p>
                  )}
                  <div className="relative">
                    <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 overflow-x-auto text-sm font-mono text-gray-300 max-h-96 overflow-y-auto">
                      <code>{snippet.code}</code>
                    </pre>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCopy(snippet); }}
                      className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors"
                      title={t('snippets.copyCode')}
                    >
                      {copiedId === snippet._id ? t('snippets.copied') : t('snippets.copy')}
                    </button>
                  </div>
                  {snippet.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {snippet.tags.map((tag) => (
                        <Badge key={tag} color="bg-gray-700 text-gray-300">{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500">
                    {t('common.created')}: {new Date(snippet.createdAt).toLocaleDateString(dateFmtLocale)}
                    {' | '}
                    {t('common.updated')}: {new Date(snippet.updatedAt).toLocaleDateString(dateFmtLocale)}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSnippet(snippet);
                        setShowForm(true);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <ConfirmButton
                      onConfirm={() => handleDelete(snippet)}
                      label={t('common.delete')}
                      confirmLabel={t('common.confirmDeleteLong')}
                      size="xs"
                    />
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
