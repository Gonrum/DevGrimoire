import { useState, useMemo } from 'react';
import { Feature, FeatureStatus, FeaturePriority, api } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect, FormTextarea } from './ui/FormField';
import Markdown from './Markdown';

const statusColors: Record<FeatureStatus, string> = {
  planned: 'bg-gray-700 text-gray-300',
  in_development: 'bg-blue-900/40 text-blue-300',
  released: 'bg-green-900/40 text-green-300',
  deprecated: 'bg-red-900/40 text-red-300',
};

const statusLabels: Record<FeatureStatus, string> = {
  planned: 'Geplant',
  in_development: 'In Entwicklung',
  released: 'Released',
  deprecated: 'Deprecated',
};

const priorityColors: Record<FeaturePriority, string> = {
  low: 'bg-gray-700 text-gray-400',
  medium: 'bg-yellow-900/40 text-yellow-300',
  high: 'bg-orange-900/40 text-orange-300',
};

const priorityLabels: Record<FeaturePriority, string> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
};

interface FeatureFormData {
  name: string;
  description: string;
  category: string;
  status: FeatureStatus;
  version: string;
  priority: FeaturePriority | '';
  tags: string;
}

const emptyForm = (): FeatureFormData => ({
  name: '', description: '', category: '', status: 'planned',
  version: '', priority: '', tags: '',
});

function fromFeature(f: Feature): FeatureFormData {
  return {
    name: f.name,
    description: f.description || '',
    category: f.category || '',
    status: f.status,
    version: f.version || '',
    priority: f.priority || '',
    tags: f.tags.join(', '),
  };
}

function FeatureForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: FeatureFormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<FeatureFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<FeatureFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    setSaving(true);
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const data = {
        projectId,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        category: form.category.trim() || undefined,
        status: form.status,
        version: form.version.trim() || undefined,
        priority: form.priority || undefined,
        tags,
      };

      if (editId) {
        await api.features.update(editId, data);
        showSuccess(`Feature "${form.name}" aktualisiert`);
      } else {
        await api.features.create(data);
        showSuccess(`Feature "${form.name}" erstellt`);
      }
      onDone();
    } catch (err: any) {
      showError(err.message || 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <h3 className="text-sm font-semibold mb-3">
          {editId ? 'Feature bearbeiten' : 'Neues Feature'}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label="Name"
            required
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="z.B. JWT Auth, REST API, Dark Mode"
          />
          <FormInput
            label="Kategorie"
            value={form.category}
            onChange={(e) => update({ category: e.target.value })}
            placeholder="z.B. Auth, API, UI, Infrastruktur"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormSelect
            label="Status"
            value={form.status}
            onChange={(e) => update({ status: e.target.value as FeatureStatus })}
          >
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </FormSelect>
          <FormSelect
            label="Prioritaet"
            value={form.priority}
            onChange={(e) => update({ priority: e.target.value as FeaturePriority | '' })}
          >
            <option value="">Keine</option>
            {Object.entries(priorityLabels).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </FormSelect>
          <FormInput
            label="Version"
            value={form.version}
            onChange={(e) => update({ version: e.target.value })}
            placeholder="z.B. v1.0.0"
          />
        </div>
        <FormTextarea
          label="Beschreibung"
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={4}
          placeholder="Was macht dieses Feature? (Markdown)"
        />
        <FormInput
          label="Tags"
          value={form.tags}
          onChange={(e) => update({ tags: e.target.value })}
          placeholder="kommagetrennt"
        />
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="md" disabled={saving}>
            {saving ? 'Speichern...' : editId ? 'Aktualisieren' : 'Erstellen'}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onCancel}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function FeatureList({ entries, projectId }: { entries: Feature[]; projectId: string }) {
  const { showSuccess, showError } = useToast();
  const [selectedStatus, setSelectedStatus] = useState<FeatureStatus | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingFeature, setEditingFeature] = useState<Feature | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const s = new Set<FeatureStatus>();
    entries.forEach((e) => s.add(e.status));
    return Array.from(s);
  }, [entries]);

  const categories = useMemo(() => {
    const c = new Set<string>();
    entries.forEach((e) => { if (e.category) c.add(e.category); });
    return Array.from(c).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (selectedStatus) result = result.filter((e) => e.status === selectedStatus);
    if (selectedCategory) result = result.filter((e) => e.category === selectedCategory);
    return result;
  }, [entries, selectedStatus, selectedCategory]);

  const handleDelete = async (feature: Feature) => {
    try {
      await api.features.delete(feature._id);
      showSuccess(`Feature "${feature.name}" geloescht`);
    } catch (err: any) {
      showError(err.message || 'Fehler beim Loeschen');
    }
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingFeature(null);
  };

  if (showForm) {
    return (
      <FeatureForm
        initial={editingFeature ? fromFeature(editingFeature) : emptyForm()}
        editId={editingFeature?._id}
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
          onClick={() => { setEditingFeature(null); setShowForm(true); }}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          + Neues Feature
        </button>
        {statuses.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedStatus(null)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedStatus === null
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              Alle ({entries.length})
            </button>
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setSelectedStatus(selectedStatus === s ? null : s)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedStatus === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {statusLabels[s]} ({entries.filter((e) => e.status === s).length})
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
        <EmptyState message="Noch keine Features dokumentiert." />
      ) : filtered.length === 0 ? (
        <EmptyState message="Keine Features mit diesen Filtern." />
      ) : (
        <div className="space-y-2">
          {filtered.map((feature) => (
            <Card key={feature._id}>
              <div
                className="cursor-pointer"
                onClick={() => setExpandedId(expandedId === feature._id ? null : feature._id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold">{feature.name}</h3>
                    <Badge color={statusColors[feature.status]}>
                      {statusLabels[feature.status]}
                    </Badge>
                    {feature.priority && (
                      <Badge color={priorityColors[feature.priority]}>
                        {priorityLabels[feature.priority]}
                      </Badge>
                    )}
                    {feature.category && (
                      <Badge color="bg-purple-900/40 text-purple-300">{feature.category}</Badge>
                    )}
                    {feature.version && (
                      <span className="text-xs font-mono text-gray-500">{feature.version}</span>
                    )}
                  </div>
                  <span className="text-gray-600 text-xs">{expandedId === feature._id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expandedId === feature._id && (
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
                  {feature.description && (
                    <Markdown>{feature.description}</Markdown>
                  )}
                  {feature.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {feature.tags.map((tag) => (
                        <Badge key={tag} color="bg-gray-700 text-gray-300">{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500">
                    Erstellt: {new Date(feature.createdAt).toLocaleDateString('de-DE')}
                    {' | '}
                    Aktualisiert: {new Date(feature.updatedAt).toLocaleDateString('de-DE')}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingFeature(feature);
                        setShowForm(true);
                      }}
                    >
                      Bearbeiten
                    </Button>
                    <ConfirmButton
                      onConfirm={() => handleDelete(feature)}
                      label="Loeschen"
                      confirmLabel="Wirklich loeschen?"
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
