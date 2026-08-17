import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChangelogEntry, Project, api } from '../api/client';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import ListCardHeader from './ui/ListCardHeader';
import Badge from './ui/Badge';
import { COMPONENT_BADGE, VERSION_BADGE } from './ui/badge-tokens';
import Markdown from './Markdown';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormTextarea } from './ui/FormField';
import { useToast } from './Toast';

const CHANGE_PREFIXES = ['feat:', 'fix:', 'refactor:', 'docs:', 'style:', 'perf:'] as const;

interface FormData {
  version: string;
  summary: string;
  component: string;
  changes: string[];
}

const emptyForm = (): FormData => ({
  version: '',
  summary: '',
  component: '',
  changes: [''],
});

function fromEntry(entry: ChangelogEntry): FormData {
  return {
    version: entry.version || '',
    summary: entry.summary || '',
    component: entry.component || '',
    changes: entry.changes.length > 0 ? [...entry.changes] : [''],
  };
}

function ChangelogForm({
  initial,
  editId,
  projectId,
  components,
  onDone,
  onCancel,
}: {
  initial: FormData;
  editId?: string;
  projectId: string;
  components: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<FormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<FormData>) => setForm((current) => ({ ...current, ...patch }));

  const updateChange = (i: number, value: string) =>
    update({ changes: form.changes.map((c, idx) => (idx === i ? value : c)) });
  const addChange = (prefix?: string) =>
    update({ changes: [...form.changes, prefix ? `${prefix} ` : ''] });
  const removeChange = (i: number) =>
    update({ changes: form.changes.length > 1 ? form.changes.filter((_, idx) => idx !== i) : [''] });

  const trimmedChanges = form.changes.map((c) => c.trim()).filter(Boolean);
  const canSubmit = trimmedChanges.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const payload: Partial<ChangelogEntry> = {
        changes: trimmedChanges,
        version: form.version.trim() || undefined,
        summary: form.summary.trim() || undefined,
        component: form.component.trim() || undefined,
      };
      if (editId) {
        await api.changelog.update(editId, payload);
        showSuccess(t('changelog.updated'));
      } else {
        await api.changelog.create({ ...payload, projectId });
        showSuccess(t('changelog.created'));
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
          {editId ? t('changelog.edit') : t('changelog.new')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormInput
            label={t('changelog.version')}
            value={form.version}
            onChange={(e) => update({ version: e.target.value })}
            placeholder={t('changelog.versionPlaceholder')}
            autoFocus
          />
          <FormInput
            label={t('changelog.component')}
            value={form.component}
            onChange={(e) => update({ component: e.target.value })}
            placeholder={t('changelog.componentPlaceholder')}
            list="changelog-components"
          />
          <datalist id="changelog-components">
            {components.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <FormTextarea
          label={t('changelog.summary')}
          value={form.summary}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder={t('changelog.summaryPlaceholder')}
          rows={2}
        />
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t('changelog.changes')} *
          </label>
          <div className="space-y-2">
            {form.changes.map((change, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={change}
                  onChange={(e) => updateChange(i, e.target.value)}
                  placeholder={t('changelog.changePlaceholder')}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 font-mono"
                />
                <Button type="button" size="sm" variant="secondary" onClick={() => removeChange(i)} disabled={form.changes.length === 1 && !change}>
                  −
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Button type="button" size="xs" onClick={() => addChange()}>
              {t('changelog.addChange')}
            </Button>
            {CHANGE_PREFIXES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => addChange(p)}
                className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors font-mono"
              >
                + {p}
              </button>
            ))}
          </div>
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

export default function ChangelogList({
  entries,
  projectId,
  project,
  onUpdate,
}: {
  entries: ChangelogEntry[];
  projectId?: string;
  project?: Project | null;
  onUpdate?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ChangelogEntry | null>(null);

  const editable = !!(projectId && onUpdate);
  const components = (project?.components || []).map((c) => c.name);

  const handleDelete = async (entry: ChangelogEntry) => {
    try {
      await api.changelog.delete(entry._id);
      showSuccess(t('changelog.deleted'));
      onUpdate?.();
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  if (showForm && editable) {
    return (
      <ChangelogForm
        initial={editing ? fromEntry(editing) : emptyForm()}
        editId={editing?._id}
        projectId={projectId}
        components={components}
        onDone={() => { setShowForm(false); setEditing(null); onUpdate(); }}
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
            {t('changelog.new')}
          </Button>
        </div>
      )}
      {entries.length === 0 ? (
        <EmptyState message={t('changelog.noChangelog')} />
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <Card key={e._id}>
              <ListCardHeader
                className="mb-2"
                title={e.version ? (
                  <Badge color={VERSION_BADGE} className="text-sm font-mono font-semibold">
                    v{e.version}
                  </Badge>
                ) : t('changelog.untitled')}
                badges={e.component ? (
                  <Badge color={COMPONENT_BADGE}>{e.component}</Badge>
                ) : undefined}
                meta={(
                  <span>
                    {new Date(e.createdAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              />
              {e.summary && (
                <div className="mb-2 text-gray-300">
                  <Markdown>{e.summary}</Markdown>
                </div>
              )}
              <ul className="text-sm text-gray-400 space-y-1">
                {e.changes.map((change, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-gray-600 shrink-0">•</span>
                    <span>{change}</span>
                  </li>
                ))}
              </ul>
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
