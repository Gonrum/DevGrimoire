import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Customer, ProjectRelatedHit } from '../api/client';
import { useDashboardEvents } from '../hooks/useProjectEvents';
import { useToast } from '../components/Toast';
import ButtonLink from '../components/ui/ButtonLink';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import Markdown from '../components/Markdown';
import { LoadingText } from '../components/ui/LoadingSpinner';

type GroupMode = 'flat' | 'tag' | 'customer';
type SearchMode = 'substring' | 'semantic';

interface CustomerLink {
  projectId: string;
  customerId: string;
  customerName: string;
  status: string;
  createdAt: string;
}

interface Section {
  id: string;
  label: string;
  projects: Project[];
}

const GROUP_MODE_KEY = 'projectsOverview.groupMode';
const COLLAPSED_KEY = 'projectsOverview.collapsedSections';
const SEARCH_MODE_KEY = 'projectsOverview.searchMode';
const SECTION_UNGROUPED = '__ungrouped__';

const readStoredMode = (): GroupMode => {
  if (typeof window === 'undefined') return 'flat';
  const v = window.localStorage.getItem(GROUP_MODE_KEY);
  return v === 'tag' || v === 'customer' ? v : 'flat';
};

const readStoredCollapsed = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const readStoredSearchMode = (): SearchMode => {
  if (typeof window === 'undefined') return 'substring';
  return window.localStorage.getItem(SEARCH_MODE_KEY) === 'semantic' ? 'semantic' : 'substring';
};

const ENTITY_ROUTES: Record<string, (projectId: string, id: string) => string> = {
  todo: (_p, id) => `/todos/${id}`,
  knowledge: (p) => `/projects/${p}?tab=knowledge`,
  manual: (p) => `/projects/${p}?tab=manuals`,
  changelog: (p) => `/projects/${p}?tab=changelog`,
  session: (p) => `/projects/${p}?tab=sessions`,
  snippet: (p) => `/projects/${p}?tab=snippets`,
  research: (p) => `/projects/${p}?tab=research`,
  attachment: (p) => `/projects/${p}?tab=attachments`,
  schema: (p) => `/projects/${p}?tab=schemas`,
};

const routeForRelated = (hit: ProjectRelatedHit): string => {
  const fn = ENTITY_ROUTES[hit.entity];
  return fn ? fn(hit.projectId, hit.id) : `/projects/${hit.projectId}`;
};

export default function ProjectsOverview() {
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerLinks, setCustomerLinks] = useState<CustomerLink[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [groupMode, setGroupMode] = useState<GroupMode>(readStoredMode);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(readStoredCollapsed()),
  );
  const [searchMode, setSearchMode] = useState<SearchMode>(readStoredSearchMode);
  const [semanticHits, setSemanticHits] = useState<Set<string> | null>(null);
  const [relatedHits, setRelatedHits] = useState<ProjectRelatedHit[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const [searchModeOpen, setSearchModeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const { showError } = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadProjects = (filterCustomerId?: string) => {
    api.projects
      .list(filterCustomerId ? { customerId: filterCustomerId } : undefined)
      .then(setProjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadCustomers = () => {
    api.customers
      .list({ includeArchived: false })
      .then(setCustomers)
      .catch(() => {
        // Filter-Hilfsmittel; bei Fehler stumm bleiben.
      });
  };

  const loadCustomerLinks = () => {
    api.projects
      .listCustomerLinks()
      .then(setCustomerLinks)
      .catch(() => setCustomerLinks([]));
  };

  const toggleFavorite = async (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.projects.update(project._id, { favorite: !project.favorite });
      loadProjects(customerFilter || undefined);
    } catch (err: any) {
      showError(err.message || t('dashboard.favoriteError'));
    }
  };

  useEffect(() => {
    loadProjects(customerFilter || undefined);
  }, [customerFilter]);

  useEffect(() => {
    loadCustomers();
    loadCustomerLinks();
  }, []);

  useDashboardEvents(() => {
    loadProjects(customerFilter || undefined);
    loadCustomerLinks();
  });

  useEffect(() => {
    window.localStorage.setItem(GROUP_MODE_KEY, groupMode);
  }, [groupMode]);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedSections]));
  }, [collapsedSections]);

  useEffect(() => {
    window.localStorage.setItem(SEARCH_MODE_KEY, searchMode);
  }, [searchMode]);

  // Semantic search: debounced + cancellable.
  useEffect(() => {
    if (searchMode !== 'semantic' || !search.trim()) {
      setSemanticHits(null);
      setRelatedHits([]);
      setSemanticLoading(false);
      return;
    }
    let cancelled = false;
    setSemanticLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const result = await api.projects.searchSemantic(
          search.trim(),
          customerFilter || undefined,
          30,
        );
        if (cancelled) return;
        if (result.projects.length === 0) {
          // Fallback to substring for this query so the user isn't left empty.
          setSemanticHits(null);
          setRelatedHits(result.relatedHits);
        } else {
          setSemanticHits(new Set(result.projects.map((p) => p._id)));
          setRelatedHits(result.relatedHits);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        // 503 with fallback: silent substring fallback. Other errors: toast.
        const msg = err instanceof Error ? err.message : String(err);
        const isFallback = /fallback/i.test(msg) || /unavailable/i.test(msg) || /503/.test(msg);
        if (!isFallback) showError(msg || t('projects.semanticSearchFailed'));
        setSemanticHits(null);
        setRelatedHits([]);
      } finally {
        if (!cancelled) setSemanticLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search, searchMode, customerFilter, showError, t]);

  const primaryCustomerByProject = useMemo(() => {
    const map = new Map<string, CustomerLink>();
    for (const link of customerLinks) {
      const existing = map.get(link.projectId);
      if (!existing || new Date(link.createdAt) < new Date(existing.createdAt)) {
        map.set(link.projectId, link);
      }
    }
    return map;
  }, [customerLinks]);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    const useSemantic = searchMode === 'semantic' && q && semanticHits !== null;

    if (useSemantic) {
      // Keep RAG ordering by mapping over Set insertion order, then look up projects.
      const byId = new Map(projects.map((p) => [p._id, p]));
      return [...semanticHits!].map((id) => byId.get(id)).filter((p): p is Project => !!p);
    }

    return [...projects]
      .filter((p) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.techStack.some((s) => s.toLowerCase().includes(q)) ||
          (p.tags ?? []).some((s) => s.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [projects, search, searchMode, semanticHits]);

  const sections = useMemo<Section[]>(() => {
    if (groupMode === 'flat') return [];

    const byKey = new Map<string, { label: string; projects: Project[] }>();

    const ungroupedKey = `${groupMode}:${SECTION_UNGROUPED}`;

    if (groupMode === 'tag') {
      for (const p of filteredProjects) {
        const primary = p.tags && p.tags.length > 0 ? p.tags[0] : null;
        const key = primary ? `tag:${primary}` : ungroupedKey;
        const label = primary ?? t('projects.sectionNoTag');
        if (!byKey.has(key)) byKey.set(key, { label, projects: [] });
        byKey.get(key)!.projects.push(p);
      }
    } else {
      for (const p of filteredProjects) {
        const link = primaryCustomerByProject.get(p._id);
        const key = link ? `customer:${link.customerId}` : ungroupedKey;
        const label = link ? link.customerName : t('projects.sectionNoCustomer');
        if (!byKey.has(key)) byKey.set(key, { label, projects: [] });
        byKey.get(key)!.projects.push(p);
      }
    }

    const entries = [...byKey.entries()].sort((a, b) => {
      if (a[0] === ungroupedKey) return 1;
      if (b[0] === ungroupedKey) return -1;
      return a[1].label.localeCompare(b[1].label, undefined, { sensitivity: 'base' });
    });

    return entries.map(([id, v]) => ({ id, label: v.label, projects: v.projects }));
  }, [groupMode, filteredProjects, primaryCustomerByProject, t]);

  const toggleCollapsed = (id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">{t('common.errorLoading', { error })}</p>
      </div>
    );
  }

  const renderCard = (p: Project, hidePrimaryTag = false) => {
    const tagsToShow = hidePrimaryTag ? (p.tags ?? []).slice(1) : p.tags ?? [];
    return (
      <Link
        key={p._id}
        to={`/projects/${p._id}`}
        className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-violet-500 transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => toggleFavorite(e, p)}
              className={`text-lg leading-none transition-colors ${
                p.favorite
                  ? 'text-yellow-400 hover:text-yellow-300'
                  : 'text-gray-700 hover:text-yellow-400'
              }`}
              title={p.favorite ? t('projects.removeFavorite') : t('projects.addFavorite')}
              aria-label={p.favorite ? t('projects.removeFavorite') : t('projects.addFavorite')}
            >
              {p.favorite ? '★' : '☆'}
            </button>
            <h2 className="text-lg font-semibold">{p.name}</h2>
          </div>
          <Badge color={p.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
            {p.active ? t('common.active') : t('common.inactive')}
          </Badge>
        </div>
        {p.description && (
          <div className="mb-3 max-h-12 overflow-hidden text-gray-400">
            <Markdown>{p.description}</Markdown>
          </div>
        )}
        {p.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {p.techStack.map((tech) => (
              <Badge key={tech} color="bg-gray-800 text-gray-300">
                {tech}
              </Badge>
            ))}
          </div>
        )}
        {tagsToShow.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tagsToShow.map((tag) => (
              <Badge key={tag} color="bg-violet-900/40 text-violet-300">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-600 mt-3">
          {t('common.created')}: {new Date(p.createdAt).toLocaleDateString(dateLocale)}
          {' · '}
          {t('common.updated')}: {new Date(p.updatedAt).toLocaleDateString(dateLocale)}
        </p>
      </Link>
    );
  };

  const showEmpty = projects.length === 0;
  const showNoMatch = !showEmpty && filteredProjects.length === 0;

  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold mb-6 font-grimoire">{t('projects.overview')}</h1>
      <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-3 mb-6">
        <ButtonLink to="/projects/new" variant="primary" size="lg" className="justify-center">
          {t('projects.newProject')}
        </ButtonLink>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {importing ? t('projects.importing') : t('projects.importJson')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImporting(true);
            try {
              const result = await api.transfer.import(file);
              loadProjects();
              navigate(`/projects/${result.projectId}`);
            } catch (err: any) {
              showError(err.message || t('projects.importFailed'));
            } finally {
              setImporting(false);
              e.target.value = '';
            }
          }}
        />
        <div className="relative flex items-center w-full sm:w-72">
          <button
            type="button"
            onClick={() => setSearchModeOpen((v) => !v)}
            onBlur={() => setTimeout(() => setSearchModeOpen(false), 120)}
            className={`absolute left-2 px-1.5 py-0.5 rounded text-sm transition-colors ${
              searchMode === 'semantic'
                ? 'text-violet-300 hover:text-violet-200'
                : 'text-gray-500 hover:text-gray-300'
            }`}
            title={t(`projects.searchMode.${searchMode}Title`)}
            aria-label={t(`projects.searchMode.${searchMode}Title`)}
          >
            {searchMode === 'semantic' ? '🧠' : '⚡'}
          </button>
          <input
            type="text"
            placeholder={t(`projects.searchMode.${searchMode}Placeholder`)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-full"
          />
          {semanticLoading && (
            <span className="absolute right-2 text-xs text-gray-500 animate-pulse">…</span>
          )}
          {searchModeOpen && (
            <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-10 overflow-hidden">
              {(['substring', 'semantic'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSearchMode(m);
                    setSearchModeOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-700 ${
                    searchMode === m ? 'text-violet-300' : 'text-gray-200'
                  }`}
                >
                  <span>{m === 'semantic' ? '🧠' : '⚡'}</span>
                  <span>{t(`projects.searchMode.${m}`)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {customers.length > 0 && (
          <select
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 w-full sm:w-56"
            title={t('projects.filterByCustomerTitle')}
          >
            <option value="">{t('projects.filterByCustomerAll')}</option>
            {customers.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className="sm:ml-auto inline-flex rounded-lg overflow-hidden border border-gray-700 bg-gray-800 text-sm">
          {(['flat', 'tag', 'customer'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setGroupMode(m)}
              className={`px-3 py-1.5 transition-colors ${
                groupMode === m
                  ? 'bg-violet-900/60 text-violet-100 ring-1 ring-inset ring-violet-500/50'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
              title={t(`projects.groupMode.${m}Title`)}
            >
              {t(`projects.groupMode.${m}`)}
            </button>
          ))}
        </div>
        {groupMode === 'tag' && (
          <Link
            to="/projects/tags"
            className="text-xs text-violet-400 hover:text-violet-300 whitespace-nowrap"
          >
            {t('projects.manageTags')}
          </Link>
        )}
      </div>

      {searchMode === 'semantic' && search.trim() && relatedHits.length > 0 && (
        <div className="mb-4 bg-gray-900/60 border border-gray-800 rounded-lg">
          <button
            type="button"
            onClick={() => setRelatedExpanded((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:text-violet-300 transition-colors"
          >
            <span className={`text-gray-500 transition-transform ${relatedExpanded ? 'rotate-90' : ''}`}>
              ▶
            </span>
            <span className="font-medium">{t('projects.relatedHits', { count: relatedHits.length })}</span>
          </button>
          {relatedExpanded && (
            <div className="px-4 pb-3 space-y-1">
              {(() => {
                const grouped = new Map<string, ProjectRelatedHit[]>();
                for (const h of relatedHits) {
                  if (!grouped.has(h.entity)) grouped.set(h.entity, []);
                  grouped.get(h.entity)!.push(h);
                }
                return [...grouped.entries()].map(([entity, hits]) => (
                  <div key={entity}>
                    <p className="text-xs uppercase tracking-wide text-gray-600 mt-2 mb-1">
                      {t(`projects.entityLabel.${entity}`, { defaultValue: entity })} ({hits.length})
                    </p>
                    <ul className="space-y-0.5">
                      {hits.map((hit) => (
                        <li key={`${hit.entity}-${hit.id}`}>
                          <Link
                            to={routeForRelated(hit)}
                            className="block text-sm text-gray-300 hover:text-violet-300 hover:bg-gray-800/60 rounded px-2 py-1 transition-colors"
                          >
                            {hit.title || hit.id}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ));
              })()}
            </div>
          )}
        </div>
      )}

      {showEmpty ? (
        <EmptyState message={t('projects.noProjects')} />
      ) : showNoMatch ? (
        <EmptyState message={t('projects.noProjectsFound', { search })} />
      ) : groupMode === 'flat' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((p) => renderCard(p))}
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((sec) => {
            const collapsed = collapsedSections.has(sec.id);
            return (
              <section key={sec.id}>
                <button
                  type="button"
                  onClick={() => toggleCollapsed(sec.id)}
                  className="w-full flex items-center gap-2 text-left mb-3 group"
                >
                  <span className={`text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`}>
                    ▶
                  </span>
                  <h2 className="text-base font-semibold text-gray-200 group-hover:text-violet-300 transition-colors">
                    {sec.label}
                  </h2>
                  <Badge color="bg-gray-800 text-gray-400" rounded="full">
                    {sec.projects.length}
                  </Badge>
                </button>
                {!collapsed && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sec.projects.map((p) => renderCard(p, groupMode === 'tag'))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
