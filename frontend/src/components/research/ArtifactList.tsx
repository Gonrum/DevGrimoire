import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ResearchArtifact, ResearchArtifactSummary } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import { useToast } from '../Toast';
import Badge from '../ui/Badge';
import EmptyState from '../ui/EmptyState';
import { LoadingText } from '../ui/LoadingSpinner';
import { VERSION_BADGE } from '../ui/badge-tokens';
import ArtifactViewer from './ArtifactViewer';

interface ArtifactListProps {
  topicId: string;
  /** Bump this to force a reload — used by `ResearchTopicPage` after a run
   * finishes, since a run may have created/updated artifacts out-of-band. */
  refreshToken?: number;
}

function toSummary(a: ResearchArtifact): ResearchArtifactSummary {
  return { slug: a.slug, title: a.title, summary: a.summary, version: a.version };
}

export default function ArtifactList({ topicId, refreshToken }: ArtifactListProps) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [artifacts, setArtifacts] = useState<ResearchArtifactSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /*
   * `showError` steht jetzt in der Dep-Liste — vorher unterdrückte ein
   * `eslint-disable` die Meldung. Die Referenz ist stabil (`ToastProvider`
   * baut sie mit `useCallback`), der Effect läuft also weiterhin nur bei
   * `topicId`/`refreshToken`.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const list = await api.researchTopics.artifactsList(topicId);
        if (cancelled) return;
        setArtifacts(list);
        setSelectedSlug((prev) => (prev && list.some((a) => a.slug === prev) ? prev : list[0]?.slug ?? null));
      } catch (err) {
        if (!cancelled) showError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topicId, refreshToken, showError]);

  const handleSaved = (updated: ResearchArtifact) => {
    setArtifacts((prev) => {
      const next = toSummary(updated);
      return prev.some((a) => a.slug === next.slug)
        ? prev.map((a) => (a.slug === next.slug ? next : a))
        : [...prev, next];
    });
  };

  const handleDeleted = (slug: string) => {
    const next = artifacts.filter((a) => a.slug !== slug);
    setArtifacts(next);
    setSelectedSlug(next[0]?.slug ?? null);
  };

  if (loading) return <LoadingText />;

  if (artifacts.length === 0) {
    return <EmptyState message={t('researchTopics.artifactsEmpty')} />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4">
      <div className="space-y-1 lg:max-h-[75vh] lg:overflow-y-auto">
        <p className="text-xs text-gray-500 mb-1">{t('researchTopics.artifactCount', { count: artifacts.length })}</p>
        {artifacts.map((a) => (
          <button
            key={a.slug}
            type="button"
            onClick={() => setSelectedSlug(a.slug)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
              a.slug === selectedSlug
                ? 'bg-violet-900/40 text-violet-200'
                : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{a.title}</span>
              <Badge color={VERSION_BADGE} rounded="full">v{a.version}</Badge>
            </div>
            <p className="text-xs text-gray-600 font-mono truncate">{a.slug}</p>
            {a.summary && <p className="text-xs text-gray-600 truncate mt-0.5">{a.summary}</p>}
          </button>
        ))}
      </div>

      <div>
        {selectedSlug ? (
          <ArtifactViewer key={selectedSlug} topicId={topicId} slug={selectedSlug} onDeleted={handleDeleted} onSaved={handleSaved} />
        ) : (
          <EmptyState message={t('researchTopics.artifactSelectHint')} />
        )}
      </div>
    </div>
  );
}
