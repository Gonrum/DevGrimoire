import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  ResearchArtifact,
  ResearchArtifactSensitivity,
  ResearchArtifactVersion,
  WriteResearchArtifactPayload,
} from '../../api/client';
import { useToast } from '../Toast';
import Markdown from '../Markdown';
import MarkdownEditor from '../MarkdownEditor';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import ConfirmButton from '../ui/ConfirmButton';
import { FormInput } from '../ui/FormField';
import { LoadingText } from '../ui/LoadingSpinner';
import { TAG_BADGE, VERSION_BADGE } from '../ui/badge-tokens';

const SENSITIVITY_BADGE: Record<ResearchArtifactSensitivity, string> = {
  public: 'bg-gray-800 text-gray-400',
  internal: 'bg-cyan-900/40 text-cyan-300',
  confidential: 'bg-amber-900/40 text-amber-300',
  personal: 'bg-purple-900/40 text-purple-300',
  secret: 'bg-red-900/40 text-red-400',
};

interface FormState {
  title: string;
  summary: string;
  content: string;
  tagsText: string;
  sources: string[];
  changeNote: string;
}

function formFromArtifact(a: ResearchArtifact): FormState {
  return {
    title: a.title,
    summary: a.summary ?? '',
    content: a.content,
    tagsText: a.tags.join(', '),
    // Mirrors ResearchList.tsx's ResearchForm: always at least one (possibly
    // empty) source row so the "+/-" row editor has something to render.
    sources: a.sources.length > 0 ? [...a.sources] : [''],
    changeNote: '',
  };
}

interface ArtifactViewerProps {
  topicId: string;
  slug: string;
  onDeleted: (slug: string) => void;
  onSaved: (artifact: ResearchArtifact) => void;
}

/**
 * Detail view for one research artifact: rendered markdown + metadata in
 * view mode, a manual edit form (title/summary/content/tags/sources/
 * changeNote), a lazily-loaded version history panel, and delete.
 *
 * Callers should mount this with `key={slug}` (see `ArtifactList.tsx`) so
 * switching the selected artifact remounts fresh state instead of requiring
 * manual reset plumbing here.
 */
export default function ArtifactViewer({ topicId, slug, onDeleted, onSaved }: ArtifactViewerProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();

  const [artifact, setArtifact] = useState<ResearchArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<ResearchArtifactVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  const [form, setForm] = useState<FormState>({
    title: '',
    summary: '',
    content: '',
    tagsText: '',
    sources: [''],
    changeNote: '',
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setShowVersions(false);
    setVersions(null);
    api.researchTopics
      .artifactGet(topicId, slug)
      .then((a) => {
        if (cancelled) return;
        setArtifact(a);
        setForm(formFromArtifact(a));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        showError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, slug]);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const updateSource = (i: number, value: string) =>
    update({ sources: form.sources.map((s, idx) => (idx === i ? value : s)) });
  const addSource = () => update({ sources: [...form.sources, ''] });
  const removeSource = (i: number) =>
    update({ sources: form.sources.length > 1 ? form.sources.filter((_, idx) => idx !== i) : [''] });

  // Re-seeds the form from the CURRENT artifact right before entering edit
  // mode — guarantees the tags/sources shown to the user (and therefore
  // re-submitted on save) always match what's actually stored, closing the
  // "edit clears tags/sources because they were omitted" footgun described
  // in the task brief.
  const startEdit = () => {
    if (!artifact) return;
    setForm(formFromArtifact(artifact));
    setEditing(true);
  };

  const canSave = form.title.trim() && form.content.trim();

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // `tags`/`sources` are ALWAYS included below, even when unchanged or
      // empty — the backend (`ResearchArtifactService.write`) treats an
      // omitted field as "clear to []", not "leave as-is" (same footgun the
      // agent's `artifact_write` tool has to be warned about).
      const payload: WriteResearchArtifactPayload = {
        title: form.title.trim(),
        content: form.content,
        summary: form.summary.trim() || undefined,
        tags: form.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
        sources: form.sources.map((s) => s.trim()).filter(Boolean),
        changeNote: form.changeNote.trim() || undefined,
      };
      const updated = await api.researchTopics.artifactSave(topicId, slug, payload);
      setArtifact(updated);
      setForm(formFromArtifact(updated));
      setEditing(false);
      setVersions(null); // the save just created a new version row — invalidate the cached list
      showSuccess(t('researchTopics.artifactSaved'));
      onSaved(updated);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.artifactSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.researchTopics.artifactDelete(topicId, slug);
      showSuccess(t('researchTopics.artifactDeleted'));
      onDeleted(slug);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.artifactDeleteFailed'));
      setDeleting(false);
    }
  };

  const toggleVersions = async () => {
    const next = !showVersions;
    setShowVersions(next);
    if (next && versions === null) {
      setVersionsLoading(true);
      try {
        const list = await api.researchTopics.artifactVersions(topicId, slug);
        setVersions(list);
      } catch (err: unknown) {
        showError(err instanceof Error ? err.message : String(err));
      } finally {
        setVersionsLoading(false);
      }
    }
  };

  if (loading) return <LoadingText />;
  if (!artifact) return null;

  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (editing) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-200">{t('researchTopics.artifactEditTitle')}</h3>
        <FormInput
          label={t('researchTopics.titleLabel')}
          required
          value={form.title}
          onChange={(e) => update({ title: e.target.value })}
          autoFocus
        />
        <FormInput
          label={t('researchTopics.artifactSummaryLabel')}
          value={form.summary}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder={t('researchTopics.artifactSummaryPlaceholder')}
        />
        <FormInput
          label={t('common.tags')}
          value={form.tagsText}
          onChange={(e) => update({ tagsText: e.target.value })}
          placeholder={t('common.commaSeparated')}
        />
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('research.sourcesLabel')}</label>
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
          <label className="block text-xs text-gray-500 mb-1">{t('research.content')} *</label>
          <MarkdownEditor value={form.content} onChange={(content) => update({ content })} rows={12} placeholder={t('research.contentPlaceholder')} />
        </div>
        <FormInput
          label={t('researchTopics.artifactChangeNoteLabel')}
          value={form.changeNote}
          onChange={(e) => update({ changeNote: e.target.value })}
          placeholder={t('researchTopics.artifactChangeNotePlaceholder')}
        />
        <div className="flex gap-2 pt-2">
          <Button type="button" variant="primary" size="md" disabled={saving || !canSave} onClick={handleSave}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={() => setEditing(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-100 truncate">{artifact.title}</h3>
          <p className="text-xs text-gray-600 font-mono truncate">{artifact.slug}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge color={VERSION_BADGE} rounded="full">v{artifact.version}</Badge>
          <Badge color={SENSITIVITY_BADGE[artifact.sensitivity]} rounded="full">
            {t(`researchTopics.sensitivity_${artifact.sensitivity}`)}
          </Badge>
        </div>
      </div>

      {artifact.summary && <p className="text-sm text-gray-400 italic">{artifact.summary}</p>}

      <Markdown className="text-gray-300">{artifact.content}</Markdown>

      {artifact.sources.length > 0 && (
        <div className="pt-3 border-t border-gray-800">
          <p className="text-xs text-gray-500 mb-1">{t('research.sources')}</p>
          <ul className="space-y-0.5">
            {artifact.sources.map((src, i) => (
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

      {artifact.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {artifact.tags.map((tag) => (
            <Badge key={tag} color={TAG_BADGE}>{tag}</Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-800">
        <Button size="xs" onClick={startEdit}>{t('common.edit')}</Button>
        <ConfirmButton
          onConfirm={handleDelete}
          label={t('common.delete')}
          confirmLabel={t('common.confirmDeleteLong')}
          size="xs"
          disabled={deleting}
        />
        <Button size="xs" variant="ghost" onClick={toggleVersions}>
          {showVersions ? t('researchTopics.artifactVersionsToggleHide') : t('researchTopics.artifactVersionsToggleShow')}
        </Button>
      </div>

      {showVersions && (
        <div className="pt-3 border-t border-gray-800 space-y-2">
          <p className="text-xs uppercase tracking-wide text-gray-500">{t('researchTopics.artifactVersionsTitle')}</p>
          {versionsLoading ? (
            <LoadingText />
          ) : versions && versions.length > 0 ? (
            versions
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <div key={v._id} className="bg-gray-950 border border-gray-800 rounded p-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-gray-400">
                      {t('researchTopics.artifactVersionEntry', { version: v.version })} · {new Date(v.createdAt).toLocaleString(locale)}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setExpandedVersion((cur) => (cur === v.version ? null : v.version))}
                    >
                      {expandedVersion === v.version ? t('researchTopics.artifactHideContent') : t('researchTopics.artifactViewContent')}
                    </Button>
                  </div>
                  {v.changeNote && <p className="text-xs text-gray-500 mt-1">{v.changeNote}</p>}
                  {expandedVersion === v.version && (
                    <div className="mt-2 pt-2 border-t border-gray-800">
                      <Markdown className="text-gray-400">{v.content}</Markdown>
                    </div>
                  )}
                </div>
              ))
          ) : (
            <p className="text-xs text-gray-600">{t('researchTopics.artifactVersionsEmpty')}</p>
          )}
        </div>
      )}
    </div>
  );
}
