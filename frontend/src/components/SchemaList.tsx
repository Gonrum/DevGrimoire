import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SchemaObject, SchemaVersion, SchemaField, SchemaIndex, DbType, api } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect, FormTextarea } from './ui/FormField';

const dbTypeColors: Record<DbType, string> = {
  mssql: 'bg-red-900/40 text-red-300',
  mysql: 'bg-orange-900/40 text-orange-300',
  mongodb: 'bg-green-900/40 text-green-300',
  postgresql: 'bg-blue-900/40 text-blue-300',
};

const dbTypeLabels: Record<DbType, string> = {
  mssql: 'MSSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  postgresql: 'PostgreSQL',
};

const emptyField = (): SchemaField => ({
  name: '', type: '', nullable: true, isPrimaryKey: false, isIndexed: false,
});

const emptyIndex = (): SchemaIndex => ({
  name: '', fields: [''], unique: false,
});

interface SchemaFormData {
  name: string;
  dbType: DbType;
  database: string;
  description: string;
  tags: string;
  fields: SchemaField[];
  indexes: SchemaIndex[];
  changeNote: string;
}

const emptyForm = (): SchemaFormData => ({
  name: '', dbType: 'postgresql', database: '', description: '', tags: '',
  fields: [emptyField()], indexes: [], changeNote: '',
});

function fromSchema(s: SchemaObject): SchemaFormData {
  return {
    name: s.name,
    dbType: s.dbType,
    database: s.database || '',
    description: s.description || '',
    tags: s.tags.join(', '),
    fields: s.fields.length > 0 ? s.fields.map((f) => ({ ...f })) : [emptyField()],
    indexes: s.indexes.map((idx) => ({ ...idx, fields: [...idx.fields] })),
    changeNote: '',
  };
}

function SchemaForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: SchemaFormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<SchemaFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<SchemaFormData>) => setForm((f) => ({ ...f, ...patch }));

  const updateField = (i: number, patch: Partial<SchemaField>) => {
    const fields = form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f));
    update({ fields });
  };

  const removeField = (i: number) => {
    update({ fields: form.fields.filter((_, j) => j !== i) });
  };

  const updateIndex = (i: number, patch: Partial<SchemaIndex>) => {
    const indexes = form.indexes.map((idx, j) => (j === i ? { ...idx, ...patch } : idx));
    update({ indexes });
  };

  const updateIndexField = (idxI: number, fieldI: number, value: string) => {
    const indexes = form.indexes.map((idx, j) => {
      if (j !== idxI) return idx;
      const fields = idx.fields.map((f, k) => (k === fieldI ? value : f));
      return { ...idx, fields };
    });
    update({ indexes });
  };

  const addIndexField = (idxI: number) => {
    const indexes = form.indexes.map((idx, j) =>
      j === idxI ? { ...idx, fields: [...idx.fields, ''] } : idx,
    );
    update({ indexes });
  };

  const removeIndexField = (idxI: number, fieldI: number) => {
    const indexes = form.indexes.map((idx, j) => {
      if (j !== idxI) return idx;
      return { ...idx, fields: idx.fields.filter((_, k) => k !== fieldI) };
    });
    update({ indexes });
  };

  const removeIndex = (i: number) => {
    update({ indexes: form.indexes.filter((_, j) => j !== i) });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.dbType) return;

    setSaving(true);
    try {
      const validFields = form.fields.filter((f) => f.name.trim() && f.type.trim());
      const validIndexes = form.indexes.filter((idx) => idx.name.trim() && idx.fields.some((f) => f.trim()));
      const cleanIndexes = validIndexes.map((idx) => ({
        ...idx,
        fields: idx.fields.filter((f) => f.trim()),
      }));

      const tags = form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const data = {
        projectId,
        name: form.name.trim(),
        dbType: form.dbType,
        database: form.database.trim() || undefined,
        description: form.description.trim() || undefined,
        fields: validFields,
        indexes: cleanIndexes,
        tags,
      };

      if (editId) {
        await api.schemas.update(editId, {
          ...data,
          changeNote: form.changeNote.trim() || undefined,
        });
        showSuccess(t('schemas.schemaUpdated', { name: form.name }));
      } else {
        await api.schemas.create(data);
        showSuccess(t('schemas.schemaCreated', { name: form.name }));
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
          {editId ? t('schemas.editSchema') : t('schemas.newSchema')}
        </h3>

        {/* Basic info */}
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label={t('common.name')}
            required
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="z.B. orders, users"
          />
          <FormSelect
            label={t('schemas.dbType')}
            required
            value={form.dbType}
            onChange={(e) => update({ dbType: e.target.value as DbType })}
          >
            <option value="postgresql">PostgreSQL</option>
            <option value="mongodb">MongoDB</option>
            <option value="mysql">MySQL</option>
            <option value="mssql">MSSQL</option>
          </FormSelect>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label={t('schemas.database')}
            value={form.database}
            onChange={(e) => update({ database: e.target.value })}
            placeholder="z.B. shop_production"
          />
          <FormInput
            label={t('common.tags')}
            value={form.tags}
            onChange={(e) => update({ tags: e.target.value })}
            placeholder="kommagetrennt, z.B. core, auth"
          />
        </div>
        <FormTextarea
          label={t('common.description')}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={2}
          placeholder={t('schemas.tablePurpose')}
        />

        {/* Fields */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">{t('common.fields')}</h4>
            <Button
              type="button"
              size="xs"
              onClick={() => update({ fields: [...form.fields, emptyField()] })}
            >
              {t('schemas.addField')}
            </Button>
          </div>
          <div className="space-y-2">
            {form.fields.map((field, i) => (
              <div key={i} className="flex items-start gap-2 bg-gray-800/50 rounded p-2">
                <div className="grid grid-cols-4 gap-2 flex-1">
                  <FormInput
                    placeholder={t('schemas.fieldName')}
                    value={field.name}
                    onChange={(e) => updateField(i, { name: e.target.value })}
                  />
                  <FormInput
                    placeholder={t('schemas.fieldType')}
                    value={field.type}
                    onChange={(e) => updateField(i, { type: e.target.value })}
                  />
                  <FormInput
                    placeholder={t('schemas.fieldDefault')}
                    value={field.defaultValue || ''}
                    onChange={(e) => updateField(i, { defaultValue: e.target.value || undefined })}
                  />
                  <FormInput
                    placeholder={t('schemas.fieldReference')}
                    value={field.reference || ''}
                    onChange={(e) => updateField(i, { reference: e.target.value || undefined })}
                  />
                </div>
                <div className="flex items-center gap-3 pt-1 shrink-0">
                  <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={field.nullable !== false}
                      onChange={(e) => updateField(i, { nullable: e.target.checked })}
                      className="rounded bg-gray-700 border-gray-600"
                    />
                    NULL
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!field.isPrimaryKey}
                      onChange={(e) => updateField(i, { isPrimaryKey: e.target.checked })}
                      className="rounded bg-gray-700 border-gray-600"
                    />
                    PK
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!field.isIndexed}
                      onChange={(e) => updateField(i, { isIndexed: e.target.checked })}
                      className="rounded bg-gray-700 border-gray-600"
                    />
                    IDX
                  </label>
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="text-gray-600 hover:text-red-400 text-sm"
                    title={t('schemas.removeField')}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Indexes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">{t('common.indexes')}</h4>
            <Button
              type="button"
              size="xs"
              onClick={() => update({ indexes: [...form.indexes, emptyIndex()] })}
            >
              {t('schemas.addIndex')}
            </Button>
          </div>
          {form.indexes.length === 0 ? (
            <p className="text-xs text-gray-600">{t('schemas.noIndexes')}</p>
          ) : (
            <div className="space-y-2">
              {form.indexes.map((idx, i) => (
                <div key={i} className="flex items-start gap-2 bg-gray-800/50 rounded p-2">
                  <div className="flex-1 space-y-2">
                    <div className="flex gap-2">
                      <FormInput
                        placeholder={t('schemas.indexName')}
                        value={idx.name}
                        onChange={(e) => updateIndex(i, { name: e.target.value })}
                      />
                      <FormInput
                        placeholder={t('schemas.indexType')}
                        value={idx.type || ''}
                        onChange={(e) => updateIndex(i, { type: e.target.value || undefined })}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-gray-500">{t('schemas.indexFields')}</span>
                      {idx.fields.map((f, fi) => (
                        <div key={fi} className="flex items-center gap-1">
                          <input
                            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 w-28 focus:outline-none focus:border-blue-500"
                            placeholder={t('schemas.fieldNamePlaceholder')}
                            value={f}
                            onChange={(e) => updateIndexField(i, fi, e.target.value)}
                          />
                          {idx.fields.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeIndexField(i, fi)}
                              className="text-gray-600 hover:text-red-400 text-xs"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addIndexField(i)}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 pt-1 shrink-0">
                    <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!idx.unique}
                        onChange={(e) => updateIndex(i, { unique: e.target.checked })}
                        className="rounded bg-gray-700 border-gray-600"
                      />
                      Unique
                    </label>
                    <button
                      type="button"
                      onClick={() => removeIndex(i)}
                      className="text-gray-600 hover:text-red-400 text-sm"
                      title={t('schemas.removeIndex')}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Change note (only for edit) */}
        {editId && (
          <FormInput
            label={t('schemas.changeNote')}
            value={form.changeNote}
            onChange={(e) => update({ changeNote: e.target.value })}
            placeholder={t('schemas.changeNotePlaceholder')}
          />
        )}

        {/* Actions */}
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

export default function SchemaList({ entries, projectId }: { entries: SchemaObject[]; projectId: string }) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [selectedDbType, setSelectedDbType] = useState<DbType | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, SchemaVersion[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSchema, setEditingSchema] = useState<SchemaObject | null>(null);

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const dbTypes = useMemo(() => {
    const types = new Set<DbType>();
    entries.forEach((e) => types.add(e.dbType));
    return Array.from(types).sort();
  }, [entries]);

  const filtered = selectedDbType
    ? entries.filter((e) => e.dbType === selectedDbType)
    : entries;

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!versions[id]) {
      setLoadingVersions(id);
      try {
        const v = await api.schemas.versions(id);
        setVersions((prev) => ({ ...prev, [id]: v }));
      } catch {
        // ignore
      }
      setLoadingVersions(null);
    }
  };

  const handleEdit = (schema: SchemaObject, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSchema(schema);
    setShowForm(true);
    setExpandedId(null);
  };

  const handleDelete = async (schema: SchemaObject) => {
    try {
      await api.schemas.delete(schema._id);
      showSuccess(t('schemas.schemaDeleted', { name: schema.name }));
    } catch (err: any) {
      showError(err.message || t('common.errorDeleting'));
    }
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingSchema(null);
  };

  // Show form
  if (showForm) {
    return (
      <SchemaForm
        initial={editingSchema ? fromSchema(editingSchema) : emptyForm()}
        editId={editingSchema?._id}
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
          onClick={() => { setEditingSchema(null); setShowForm(true); }}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          {t('schemas.newSchema')}
        </button>
        {dbTypes.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedDbType(null)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedDbType === null
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('common.all')} ({entries.length})
            </button>
            {dbTypes.map((dt) => (
              <button
                key={dt}
                onClick={() => setSelectedDbType(selectedDbType === dt ? null : dt)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedDbType === dt
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {dbTypeLabels[dt]} ({entries.filter((e) => e.dbType === dt).length})
              </button>
            ))}
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState message={t('schemas.noSchemas')} />
      ) : (
        <div className="space-y-3">
          {filtered.map((schema) => (
            <Card key={schema._id}>
              <div
                className="cursor-pointer"
                onClick={() => toggleExpand(schema._id)}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold font-mono">{schema.name}</h3>
                    <Badge color={dbTypeColors[schema.dbType]}>
                      {dbTypeLabels[schema.dbType]}
                    </Badge>
                    <span className="text-xs text-gray-500">v{schema.version}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>{t('schemas.fieldsCount', { count: schema.fields.length })}</span>
                    {schema.indexes.length > 0 && (
                      <span>{t('schemas.indexesCount', { count: schema.indexes.length })}</span>
                    )}
                    <span>{new Date(schema.updatedAt).toLocaleDateString(dateFmtLocale)}</span>
                    <span className="text-gray-600">{expandedId === schema._id ? '▲' : '▼'}</span>
                  </div>
                </div>
                {schema.database && (
                  <p className="text-xs text-gray-500 mb-1">DB: {schema.database}</p>
                )}
                {schema.description && (
                  <p className="text-xs text-gray-400">{schema.description}</p>
                )}
                {schema.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {schema.tags.map((tag) => (
                      <Badge key={tag} color="bg-purple-900/40 text-purple-300">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              {expandedId === schema._id && (
                <div className="mt-4 border-t border-gray-800 pt-4 space-y-4">
                  {/* Action buttons */}
                  <div className="flex gap-2">
                    <Button size="xs" onClick={(e) => handleEdit(schema, e)}>
                      {t('common.edit')}
                    </Button>
                    <ConfirmButton
                      onConfirm={() => handleDelete(schema)}
                      label={t('common.delete')}
                      confirmLabel={t('common.confirmDeleteLong')}
                      size="xs"
                    />
                  </div>

                  {/* Fields Table */}
                  {schema.fields.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">{t('common.fields')}</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500 border-b border-gray-800">
                              <th className="text-left py-1.5 pr-3 font-medium">{t('common.name')}</th>
                              <th className="text-left py-1.5 pr-3 font-medium">Typ</th>
                              <th className="text-center py-1.5 pr-3 font-medium">NULL</th>
                              <th className="text-center py-1.5 pr-3 font-medium">PK</th>
                              <th className="text-center py-1.5 pr-3 font-medium">IDX</th>
                              <th className="text-left py-1.5 pr-3 font-medium">Default</th>
                              <th className="text-left py-1.5 pr-3 font-medium">{t('schemas.fieldRef')}</th>
                              <th className="text-left py-1.5 font-medium">{t('schemas.fieldDescription')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {schema.fields.map((f, i) => (
                              <tr key={i} className="border-b border-gray-800/50">
                                <td className="py-1.5 pr-3 font-mono text-gray-200">{f.name}</td>
                                <td className="py-1.5 pr-3 font-mono text-yellow-400/80">{f.type}</td>
                                <td className="py-1.5 pr-3 text-center">{f.nullable !== false ? '✓' : '—'}</td>
                                <td className="py-1.5 pr-3 text-center">{f.isPrimaryKey ? '🔑' : ''}</td>
                                <td className="py-1.5 pr-3 text-center">{f.isIndexed ? '✓' : ''}</td>
                                <td className="py-1.5 pr-3 text-gray-500 font-mono">{f.defaultValue || ''}</td>
                                <td className="py-1.5 pr-3 text-cyan-400/70 font-mono">{f.reference || ''}</td>
                                <td className="py-1.5 text-gray-500">{f.description || ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Indexes Table */}
                  {schema.indexes.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">{t('common.indexes')}</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500 border-b border-gray-800">
                              <th className="text-left py-1.5 pr-3 font-medium">{t('common.name')}</th>
                              <th className="text-left py-1.5 pr-3 font-medium">{t('common.fields')}</th>
                              <th className="text-center py-1.5 pr-3 font-medium">Unique</th>
                              <th className="text-left py-1.5 font-medium">Typ</th>
                            </tr>
                          </thead>
                          <tbody>
                            {schema.indexes.map((idx, i) => (
                              <tr key={i} className="border-b border-gray-800/50">
                                <td className="py-1.5 pr-3 font-mono text-gray-200">{idx.name}</td>
                                <td className="py-1.5 pr-3 font-mono text-gray-400">{idx.fields.join(', ')}</td>
                                <td className="py-1.5 pr-3 text-center">{idx.unique ? '✓' : ''}</td>
                                <td className="py-1.5 text-gray-500">{idx.type || ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Version History */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">
                      {t('schemas.versionHistory')}
                    </h4>
                    {loadingVersions === schema._id ? (
                      <p className="text-xs text-gray-500">{t('common.loading')}</p>
                    ) : (versions[schema._id] || []).length === 0 ? (
                      <p className="text-xs text-gray-600">{t('schemas.noPreviousVersions')}</p>
                    ) : (
                      <div className="space-y-1">
                        {(versions[schema._id] || []).map((v) => (
                          <div
                            key={v._id}
                            className="flex items-center gap-3 text-xs py-1.5 border-b border-gray-800/50"
                          >
                            <span className="font-mono text-gray-300">v{v.version}</span>
                            <span className="text-gray-500">
                              {new Date(v.createdAt).toLocaleString(dateFmtLocale)}
                            </span>
                            <span className="text-gray-500">
                              {t('schemas.fieldsCount', { count: v.fields.length })}, {t('schemas.indexesCount', { count: v.indexes.length })}
                            </span>
                            {v.changeNote && (
                              <span className="text-gray-400 italic">{v.changeNote}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
