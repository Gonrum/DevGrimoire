import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Release, ReleaseStatus, ReleasePlatform, ReleaseType, api } from '../api/client';
import { errorMessage, optionOr } from '../lib/narrow';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect, FormTextarea } from './ui/FormField';
import Markdown from './Markdown';

const statusColors: Record<ReleaseStatus, string> = {
  draft: 'bg-gray-700 text-gray-300',
  published: 'bg-green-900/40 text-green-300',
  archived: 'bg-yellow-900/40 text-yellow-300',
};

const platformColors: Record<ReleasePlatform, string> = {
  android: 'bg-green-900/40 text-green-300',
  ios: 'bg-blue-900/40 text-blue-300',
  web: 'bg-cyan-900/40 text-cyan-300',
  desktop: 'bg-purple-900/40 text-purple-300',
  docker: 'bg-sky-900/40 text-sky-300',
  other: 'bg-gray-700 text-gray-400',
};

/*
 * Laufzeit-Whitelists der beiden `<select>`s. `satisfies` prüft die Literale
 * gegen die Union, `as const` erhält sie — damit liefert `optionOr` den
 * Union-Typ statt `string` und die Casts entfallen.
 */
const RELEASE_PLATFORMS = [
  'android', 'ios', 'web', 'desktop', 'docker', 'other',
] as const satisfies readonly ReleasePlatform[];

const RELEASE_STATUSES = ['draft', 'published', 'archived'] as const satisfies readonly ReleaseStatus[];

const platformLabels: Record<ReleasePlatform, string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  desktop: 'Desktop',
  docker: 'Docker',
  other: 'Other',
};

interface ReleaseFormData {
  version: string;
  title: string;
  description: string;
  platform: ReleasePlatform;
  status: ReleaseStatus;
  downloadUrl: string;
  tags: string;
}

const emptyForm = (): ReleaseFormData => ({
  version: '', title: '', description: '', platform: 'other',
  status: 'draft', downloadUrl: '', tags: '',
});

function fromRelease(r: Release): ReleaseFormData {
  return {
    version: r.version,
    title: r.title || '',
    description: r.description || '',
    platform: r.platform,
    status: r.status,
    downloadUrl: r.downloadUrl || '',
    tags: r.tags.join(', '),
  };
}

function ReleaseForm({
  initial,
  editId,
  projectId,
  onDone,
  onCancel,
}: {
  initial: ReleaseFormData;
  editId?: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<ReleaseFormData>(initial);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<ReleaseFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.version.trim()) return;

    setSaving(true);
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const data = {
        projectId,
        version: form.version.trim(),
        title: form.title.trim() || undefined,
        description: form.description.trim() || undefined,
        platform: form.platform,
        status: form.status,
        downloadUrl: form.downloadUrl.trim() || undefined,
        releaseType: 'manual' as ReleaseType,
        tags,
      };

      if (editId) {
        await api.releases.update(editId, data);
        showSuccess(`Release ${form.version} aktualisiert`);
      } else {
        await api.releases.create(data);
        showSuccess(`Release ${form.version} erstellt`);
      }
      onDone();
    } catch (err) {
      showError(errorMessage(err, t('common.errorSaving')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
        <h3 className="text-sm font-semibold mb-3">
          {editId ? 'Release bearbeiten' : 'Neues Release'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label="Version"
            required
            value={form.version}
            onChange={(e) => update({ version: e.target.value })}
            placeholder="z.B. 1.2.0, v2.0.0-beta"
          />
          <FormInput
            label="Titel"
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="z.B. Feature Release, Hotfix"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FormSelect
            label="Plattform"
            value={form.platform}
            onChange={(e) => update({ platform: optionOr(e.target.value, RELEASE_PLATFORMS, form.platform) })}
          >
            {RELEASE_PLATFORMS.map((key) => (
              <option key={key} value={key}>{platformLabels[key]}</option>
            ))}
          </FormSelect>
          <FormSelect
            label={t('common.status')}
            value={form.status}
            onChange={(e) => update({ status: optionOr(e.target.value, RELEASE_STATUSES, form.status) })}
          >
            <option value="draft">Entwurf</option>
            <option value="published">Veröffentlicht</option>
            <option value="archived">Archiviert</option>
          </FormSelect>
          <FormInput
            label="Download-URL"
            value={form.downloadUrl}
            onChange={(e) => update({ downloadUrl: e.target.value })}
            placeholder="https://..."
          />
        </div>
        <FormTextarea
          label={t('common.description')}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={4}
          placeholder="Release Notes (Markdown)"
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

export default function ReleaseList({ entries, projectId }: { entries: Release[]; projectId: string }) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [selectedStatus, setSelectedStatus] = useState<ReleaseStatus | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<ReleasePlatform | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRelease, setEditingRelease] = useState<Release | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const statuses = useMemo(() => {
    const s = new Set<ReleaseStatus>();
    entries.forEach((e) => s.add(e.status));
    return Array.from(s);
  }, [entries]);

  const platforms = useMemo(() => {
    const p = new Set<ReleasePlatform>();
    entries.forEach((e) => p.add(e.platform));
    return Array.from(p);
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (selectedStatus) result = result.filter((e) => e.status === selectedStatus);
    if (selectedPlatform) result = result.filter((e) => e.platform === selectedPlatform);
    return result;
  }, [entries, selectedStatus, selectedPlatform]);

  const handleDelete = async (release: Release) => {
    try {
      await api.releases.delete(release._id);
      showSuccess(`Release ${release.version} gelöscht`);
    } catch (err) {
      showError(errorMessage(err, t('common.errorDeleting')));
    }
  };

  const handleFormDone = () => {
    setShowForm(false);
    setEditingRelease(null);
  };

  if (showForm) {
    return (
      <ReleaseForm
        initial={editingRelease ? fromRelease(editingRelease) : emptyForm()}
        editId={editingRelease?._id}
        projectId={projectId}
        onDone={handleFormDone}
        onCancel={handleFormDone}
      />
    );
  }

  const statusLabel = (s: ReleaseStatus) => {
    const labels: Record<ReleaseStatus, string> = { draft: 'Entwurf', published: 'Veröffentlicht', archived: 'Archiviert' };
    return labels[s];
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => { setEditingRelease(null); setShowForm(true); }}
          className="px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors"
        >
          Neues Release
        </button>
        {statuses.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedStatus(null)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedStatus === null
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('common.all')} ({entries.length})
            </button>
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setSelectedStatus(selectedStatus === s ? null : s)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedStatus === s
                    ? 'bg-violet-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {statusLabel(s)} ({entries.filter((e) => e.status === s).length})
              </button>
            ))}
          </div>
        )}
        {platforms.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {platforms.map((p) => (
              <button
                key={p}
                onClick={() => setSelectedPlatform(selectedPlatform === p ? null : p)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  selectedPlatform === p
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {platformLabels[p]}
              </button>
            ))}
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState message="Keine Releases vorhanden" />
      ) : filtered.length === 0 ? (
        <EmptyState message="Keine Releases mit diesem Filter" />
      ) : (
        <div className="space-y-2">
          {filtered.map((release) => (
            <Card key={release._id}>
              <div
                className="cursor-pointer"
                onClick={() => setExpandedId(expandedId === release._id ? null : release._id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold font-mono">{release.version}</h3>
                    {release.title && (
                      <span className="text-sm text-gray-300">{release.title}</span>
                    )}
                    <Badge color={statusColors[release.status]}>
                      {statusLabel(release.status)}
                    </Badge>
                    <Badge color={platformColors[release.platform]}>
                      {platformLabels[release.platform]}
                    </Badge>
                    {release.releaseType === 'gitlab' && (
                      <Badge color="bg-orange-900/40 text-orange-300">GitLab</Badge>
                    )}
                    {release.assets.length > 0 && (
                      <span className="text-xs text-gray-500">{release.assets.length} Assets</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {new Date(release.createdAt).toLocaleDateString(dateFmtLocale)}
                    </span>
                    <span className="text-gray-600 text-xs">{expandedId === release._id ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </div>
              </div>

              {expandedId === release._id && (
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
                  {release.description && (
                    <Markdown>{release.description}</Markdown>
                  )}
                  {release.downloadUrl && (
                    <div>
                      <a
                        href={release.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-cyan-400 hover:text-cyan-300 underline"
                      >
                        Download
                      </a>
                    </div>
                  )}
                  {release.assets.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-400 mb-1.5">Assets</h4>
                      <div className="space-y-1">
                        {release.assets.map((asset, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <a
                              href={asset.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-400 hover:text-cyan-300 underline truncate"
                            >
                              {asset.name}
                            </a>
                            {asset.format && (
                              <span className="text-xs text-gray-500">{asset.format}</span>
                            )}
                            {asset.size && (
                              <span className="text-xs text-gray-500">
                                {(asset.size / 1024 / 1024).toFixed(1)} MB
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {release.gitlabTagName && (
                    <div className="text-xs text-gray-500">
                      GitLab Tag: <span className="font-mono">{release.gitlabTagName}</span>
                    </div>
                  )}
                  {release.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {release.tags.map((tag) => (
                        <Badge key={tag} color="bg-gray-700 text-gray-300">{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500">
                    {t('common.created')}: {new Date(release.createdAt).toLocaleDateString(dateFmtLocale)}
                    {' | '}
                    {t('common.updated')}: {new Date(release.updatedAt).toLocaleDateString(dateFmtLocale)}
                  </div>
                  {release.releaseType !== 'gitlab' && (
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingRelease(release);
                          setShowForm(true);
                        }}
                      >
                        {t('common.edit')}
                      </Button>
                      <ConfirmButton
                        onConfirm={() => handleDelete(release)}
                        label={t('common.delete')}
                        confirmLabel={t('common.confirmDeleteLong')}
                        size="xs"
                      />
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
