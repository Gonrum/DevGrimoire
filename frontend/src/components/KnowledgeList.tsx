import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Knowledge, api } from '../api/client';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect } from './ui/FormField';
import FilterPill from './ui/FilterPill';
import TabToolbar from './ui/TabToolbar';

interface KnowledgeFormData {
  topic: string;
  scope: 'project' | 'global';
  category: string;
  tags: string;
  content: string;
}

const emptyForm = (): KnowledgeFormData => ({
  topic: '',
  scope: 'project',
  category: '',
  tags: '',
  content: '',
});

function fromKnowledge(entry: Knowledge): KnowledgeFormData {
  return {
    topic: entry.topic,
    scope: entry.scope === 'global' ? 'global' : 'project',
    category: entry.category || '',
    tags: entry.tags.join(', '),
    content: entry.content,
  };
}

function KnowledgeForm({
  initial,
  editId,
  projectId,
  categories,
  onDone,
  onCancel,
}: {
  initial: KnowledgeFormData;
  editId?: string;
  projectId: string;
  categories: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<KnowledgeFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<KnowledgeFormData>) => setForm((current) => ({ ...current, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.topic.trim() || !form.content.trim()) return;

    setSaving(true);
    try {
      const payload = {
        topic: form.topic.trim(),
        content: form.content,
        category: form.category.trim() || undefined,
        tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      };

      if (editId) {
        await api.knowledge.update(editId, payload);
        showSuccess(t('knowledge.updated', { topic: payload.topic }));
      } else {
        await api.knowledge.create({
          ...payload,
          scope: form.scope,
          projectId: form.scope === 'project' ? projectId : undefined,
        });
        showSuccess(t('knowledge.created', { topic: payload.topic }));
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
          {editId ? t('knowledge.editEntry') : t('knowledge.newEntry')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormInput
            label={t('knowledge.topic')}
            required
            value={form.topic}
            onChange={(e) => update({ topic: e.target.value })}
            placeholder={t('knowledge.topicPlaceholder')}
            autoFocus
          />
          <FormInput
            label={t('common.category')}
            value={form.category}
            onChange={(e) => update({ category: e.target.value })}
            placeholder={t('knowledge.categoryPlaceholder')}
            list="knowledge-categories"
          />
          <datalist id="knowledge-categories">
            {categories.map((category) => <option key={category} value={category} />)}
          </datalist>
        </div>
        <FormSelect
          label={t('knowledge.scope')}
          value={form.scope}
          disabled={!!editId}
          onChange={(e) => update({ scope: e.target.value as 'project' | 'global' })}
        >
          <option value="project">{t('knowledge.scopeProject')}</option>
          <option value="global">{t('knowledge.scopeGlobal')}</option>
        </FormSelect>
        <FormInput
          label={t('common.tags')}
          value={form.tags}
          onChange={(e) => update({ tags: e.target.value })}
          placeholder={t('common.commaSeparated')}
        />
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t('knowledge.content')} *
          </label>
          <MarkdownEditor
            value={form.content}
            onChange={(content) => update({ content })}
            rows={12}
            placeholder={t('knowledge.contentPlaceholder')}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="md" disabled={saving || !form.topic.trim() || !form.content.trim()}>
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

export default function KnowledgeList({
  entries,
  projectId,
  onUpdate,
}: {
  entries: Knowledge[];
  projectId: string;
  onUpdate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Knowledge | null>(null);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    entries.forEach((e) => { if (e.category) cats.add(e.category); });
    return Array.from(cats).sort();
  }, [entries]);

  const filtered = selectedCategory
    ? entries.filter((e) => e.category === selectedCategory)
    : entries;

  const visibleEntries = selectedCategory === '__none__'
    ? entries.filter((e) => !e.category)
    : filtered;

  const handleFormDone = () => {
    setShowForm(false);
    setEditingEntry(null);
    onUpdate();
  };

  const handleDelete = async (entry: Knowledge) => {
    try {
      await api.knowledge.delete(entry._id);
      showSuccess(t('knowledge.deleted', { topic: entry.topic }));
      onUpdate();
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  if (showForm) {
    return (
      <KnowledgeForm
        initial={editingEntry ? fromKnowledge(editingEntry) : emptyForm()}
        editId={editingEntry?._id}
        projectId={projectId}
        categories={categories}
        onDone={handleFormDone}
        onCancel={() => { setShowForm(false); setEditingEntry(null); }}
      />
    );
  }

  return (
    <div>
      <TabToolbar
        className="mb-4"
        primaryAction={(
          <Button type="button" variant="primary" size="sm" onClick={() => { setEditingEntry(null); setShowForm(true); }}>
            {t('knowledge.newEntry')}
          </Button>
        )}
        filters={entries.length > 0 ? (
          <>
            <FilterPill active={selectedCategory === null} count={entries.length} onClick={() => setSelectedCategory(null)}>
              {t('common.all')}
            </FilterPill>
            {categories.map((cat) => (
              <FilterPill key={cat} active={selectedCategory === cat} count={entries.filter((e) => e.category === cat).length} onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}>
                {cat}
              </FilterPill>
            ))}
            {entries.some((e) => !e.category) && (
              <FilterPill active={selectedCategory === '__none__'} count={entries.filter((e) => !e.category).length} onClick={() => setSelectedCategory('__none__')}>
                {t('knowledge.noCategory')}
              </FilterPill>
            )}
          </>
        ) : undefined}
      />
      {entries.length === 0 ? (
        <EmptyState message={t('knowledge.noKnowledge')} />
      ) : visibleEntries.length === 0 ? (
        <EmptyState message={t('knowledge.noFiltered')} />
      ) : (
        <div className="space-y-4">
          {visibleEntries.map((e) => (
            <Card key={e._id}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-sm font-semibold truncate">{e.topic}</h3>
                  {e.category && (
                    <Badge color="bg-indigo-900/40 text-indigo-300">
                      {e.category}
                    </Badge>
                  )}
                  {e.scope === 'global' && (
                    <Badge color="bg-cyan-900/40 text-cyan-300">
                      {t('knowledge.scopeGlobalShort')}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-gray-600 shrink-0">
                  {new Date(e.updatedAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US')}
                </span>
              </div>
              <Markdown className="text-gray-400">{e.content}</Markdown>
              {e.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {e.tags.map((tag) => (
                    <Badge key={tag} color="bg-purple-900/40 text-purple-300">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex gap-2 mt-4 pt-3 border-t border-gray-800">
                <Button
                  size="xs"
                  onClick={() => {
                    setEditingEntry(e);
                    setShowForm(true);
                  }}
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
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
