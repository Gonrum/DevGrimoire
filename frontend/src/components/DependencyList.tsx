import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Dependency, PackageManager, api } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect, FormTextarea } from './ui/FormField';

const pmColors: Record<PackageManager, string> = {
  npm: 'bg-red-900/40 text-red-300',
  composer: 'bg-orange-900/40 text-orange-300',
  pip: 'bg-yellow-900/40 text-yellow-300',
  cargo: 'bg-amber-900/40 text-amber-300',
  go: 'bg-cyan-900/40 text-cyan-300',
  maven: 'bg-blue-900/40 text-blue-300',
  nuget: 'bg-purple-900/40 text-purple-300',
  gem: 'bg-pink-900/40 text-pink-300',
};

const pmLabels: Record<PackageManager, string> = {
  npm: 'npm',
  composer: 'Composer',
  pip: 'pip',
  cargo: 'Cargo',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  gem: 'Gem',
};

interface DependencyFormData {
  name: string;
  version: string;
  packageManager: PackageManager;
  description: string;
  devDependency: boolean;
  category: string;
  tags: string;
}

const emptyForm = (): DependencyFormData => ({
  name: '', version: '', packageManager: 'npm', description: '',
  devDependency: false, category: '', tags: '',
});

function fromDependency(d: Dependency): DependencyFormData {
  return {
    name: d.name,
    version: d.version,
    packageManager: d.packageManager,
    description: d.description || '',
    devDependency: d.devDependency,
    category: d.category || '',
    tags: d.tags.join(', '),
  };
}

function DependencyForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: DependencyFormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<DependencyFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<DependencyFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.version.trim()) return;

    setSaving(true);
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const data = {
        projectId,
        name: form.name.trim(),
        version: form.version.trim(),
        packageManager: form.packageManager,
        description: form.description.trim() || undefined,
        devDependency: form.devDependency,
        category: form.category.trim() || undefined,
        tags,
      };

      if (editId) {
        await api.dependencies.update(editId, data);
        showSuccess(t('dependencies.depUpdated', { name: form.name }));
      } else {
        await api.dependencies.create(data);
        showSuccess(t('dependencies.depCreated', { name: form.name }));
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
          {editId ? t('dependencies.editDependency') : t('dependencies.newDependency')}
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <FormInput
            label={t('common.name')}
            required
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="z.B. react, lodash"
          />
          <FormInput
            label={t('common.version')}
            required
            value={form.version}
            onChange={(e) => update({ version: e.target.value })}
            placeholder="z.B. ^18.2.0"
          />
          <FormSelect
            label={t('dependencies.packageManager')}
            required
            value={form.packageManager}
            onChange={(e) => update({ packageManager: e.target.value as PackageManager })}
          >
            {Object.entries(pmLabels).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </FormSelect>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label={t('common.category')}
            value={form.category}
            onChange={(e) => update({ category: e.target.value })}
            placeholder="z.B. framework, testing, utility"
          />
          <FormInput
            label={t('common.tags')}
            value={form.tags}
            onChange={(e) => update({ tags: e.target.value })}
            placeholder={t('common.commaSeparated')}
          />
        </div>
        <FormTextarea
          label={t('common.description')}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={2}
          placeholder={t('dependencies.purposePlaceholder')}
        />
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={form.devDependency}
            onChange={(e) => update({ devDependency: e.target.checked })}
            className="rounded bg-gray-700 border-gray-600"
          />
          {t('dependencies.devDependency')}
        </label>
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

export default function DependencyList({ entries, projectId }: { entries: Dependency[]; projectId: string }) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [selectedPm, setSelectedPm] = useState<PackageManager | null>(null);
  const [showDevOnly, setShowDevOnly] = useState<boolean | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingDep, setEditingDep] = useState<Dependency | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const packageManagers = useMemo(() => {
    const pms = new Set<PackageManager>();
    entries.forEach((e) => pms.add(e.packageManager));
    return Array.from(pms).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (selectedPm) result = result.filter((e) => e.packageManager === selectedPm);
    if (showDevOnly === true) result = result.filter((e) => e.devDependency);
    if (showDevOnly === false) result = result.filter((e) => !e.devDependency);
    return result;
  }, [entries, selectedPm, showDevOnly]);

  const handleDelete = async (dep: Dependency) => {
    try {
      await api.dependencies.delete(dep._id);
      showSuccess(t('dependencies.depDeleted', { name: dep.name }));
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingDep(null);
  };

  if (showForm) {
    return (
      <DependencyForm
        initial={editingDep ? fromDependency(editingDep) : emptyForm()}
        editId={editingDep?._id}
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
          onClick={() => { setEditingDep(null); setShowForm(true); }}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          {t('dependencies.newDependency')}
        </button>
        {packageManagers.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedPm(null)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedPm === null
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('common.all')} ({entries.length})
            </button>
            {packageManagers.map((pm) => (
              <button
                key={pm}
                onClick={() => setSelectedPm(selectedPm === pm ? null : pm)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedPm === pm
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {pmLabels[pm]} ({entries.filter((e) => e.packageManager === pm).length})
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <button
            onClick={() => setShowDevOnly(showDevOnly === false ? null : false)}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              showDevOnly === false
                ? 'bg-green-700 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            Prod
          </button>
          <button
            onClick={() => setShowDevOnly(showDevOnly === true ? null : true)}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              showDevOnly === true
                ? 'bg-yellow-700 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            Dev
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState message={t('dependencies.noDependencies')} />
      ) : filtered.length === 0 ? (
        <EmptyState message={t('dependencies.noFiltered')} />
      ) : (
        <div className="space-y-2">
          {filtered.map((dep) => (
            <Card key={dep._id}>
              <div
                className="cursor-pointer"
                onClick={() => setExpandedId(expandedId === dep._id ? null : dep._id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold font-mono">{dep.name}</h3>
                    <span className="text-xs font-mono text-gray-400">{dep.version}</span>
                    <Badge color={pmColors[dep.packageManager]}>
                      {pmLabels[dep.packageManager]}
                    </Badge>
                    {dep.devDependency && (
                      <Badge color="bg-yellow-900/40 text-yellow-300">dev</Badge>
                    )}
                    {dep.category && (
                      <Badge color="bg-gray-700 text-gray-300">{dep.category}</Badge>
                    )}
                  </div>
                  <span className="text-gray-600 text-xs">{expandedId === dep._id ? '▲' : '▼'}</span>
                </div>
                {dep.description && (
                  <p className="text-xs text-gray-400 mt-1">{dep.description}</p>
                )}
              </div>

              {expandedId === dep._id && (
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                  {dep.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {dep.tags.map((tag) => (
                        <Badge key={tag} color="bg-purple-900/40 text-purple-300">{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500">
                    {t('common.addedOn')}: {new Date(dep.createdAt).toLocaleDateString(dateFmtLocale)}
                    {' | '}
                    {t('common.updated')}: {new Date(dep.updatedAt).toLocaleDateString(dateFmtLocale)}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingDep(dep);
                        setShowForm(true);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <ConfirmButton
                      onConfirm={() => handleDelete(dep)}
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
