import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Attachment,
  Contact,
  Customer,
  CustomerProjectLink,
  CustomerStatus,
  Environment,
  Knowledge,
  Manual,
  Project,
  RecurringTask,
  ResearchEntry,
  SecretListItem,
  Snippet,
  Todo,
  api,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import EmptyState from '../components/ui/EmptyState';
import Markdown from '../components/Markdown';
import ProjectTabShell from '../components/ui/ProjectTabShell';
import TodoBoard from '../components/TodoBoard';
import RecurringTaskList from '../components/RecurringTaskList';
import KnowledgeList from '../components/KnowledgeList';
import ManualView from '../components/ManualView';
import FileUploadZone from '../components/FileUploadZone';
import EnvironmentList, { SecretsList } from '../components/EnvironmentList';
import MonitoringTab from '../components/MonitoringTab';
import SshConnectionsTab from '../components/ssh/SshConnectionsTab';
import { KubeClustersTab } from '../components/kube/KubeClustersTab';
import HarnessView from '../components/HarnessView';
import { harnessSectionCount } from '../lib/harness';
import SnippetList from '../components/SnippetList';
import ResearchList from '../components/ResearchList';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';
import { WorkflowProjectTab } from '../components/workflows/WorkflowProjectTab';
import { errorMessage } from '../lib/narrow';

type Tab =
  | 'overview'
  | 'projects'
  | 'todos'
  | 'knowledge'
  | 'manual'
  | 'workflows'
  | 'environments'
  | 'secrets'
  | 'files'
  | 'monitoring'
  | 'ssh'
  | 'kube'
  | 'contacts'
  | 'activity'
  | 'soul'
  | 'snippets'
  | 'research'
  | 'automation';

const statusColors: Record<CustomerStatus, string> = {
  lead: 'bg-blue-900/50 text-blue-300',
  onboarding: 'bg-cyan-900/50 text-cyan-300',
  active: 'bg-green-900 text-green-300',
  paused: 'bg-yellow-900/50 text-yellow-300',
  offboarding: 'bg-orange-900/50 text-orange-300',
  cancelled: 'bg-red-900/50 text-red-300',
  archived: 'bg-gray-800 text-gray-500',
};

interface AggregatedData {
  todos: Todo[];
  knowledge: Knowledge[];
  recurring: RecurringTask[];
  environments: Environment[];
  secrets: SecretListItem[];
  attachments: Attachment[];
  activity: Activity[];
}

const emptyAggregate: AggregatedData = {
  todos: [],
  knowledge: [],
  recurring: [],
  environments: [],
  secrets: [],
  attachments: [],
  activity: [],
};

export default function CustomerDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [links, setLinks] = useState<CustomerProjectLink[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [customerTodos, setCustomerTodos] = useState<Todo[]>([]);
  const [customerRecurring, setCustomerRecurring] = useState<RecurringTask[]>([]);
  const [customerKnowledge, setCustomerKnowledge] = useState<Knowledge[]>([]);
  const [customerManuals, setCustomerManuals] = useState<Manual[]>([]);
  const [customerAttachments, setCustomerAttachments] = useState<Attachment[]>([]);
  const [customerEnvironments, setCustomerEnvironments] = useState<Environment[]>([]);
  const [customerSecrets, setCustomerSecrets] = useState<SecretListItem[]>([]);
  // Abschnitte der eigenen Kundenebene — siehe ProjectDetail.
  const [harnessSections, setHarnessSections] = useState(0);
  const [customerActivity, setCustomerActivity] = useState<Activity[]>([]);
  const [customerSnippets, setCustomerSnippets] = useState<Snippet[]>([]);
  const [customerResearch, setCustomerResearch] = useState<ResearchEntry[]>([]);
  const [storageEnabled, setStorageEnabled] = useState<boolean>(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  /*
   * `loading` und `error` werden abgeleitet statt im Effect gesetzt
   * (`set-state-in-effect`). `loadedId` hält, zu welchem Kunden die aktuell
   * angezeigten Daten gehören; der Fehler trägt seine `id` mit, damit beim
   * Wechsel auf einen anderen Kunden nicht die Fehlerbox des vorigen bleibt.
   *
   * Nebeneffekt und Absicht: `loadBase` als `onUpdate` eines Kindes (Datei
   * gelöscht, Kontakt angelegt, …) baut die Seite nicht mehr auf
   * "Laden…" zurück. Vorher unmountete jeder solche Refresh den kompletten
   * Tab-Inhalt — eine gerade aufgeklappte "auch in Kapiteln"-Sektion war
   * danach wieder zu.
   */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const loading = id !== undefined && loadedId !== id;
  const error = failure !== null && failure.id === id ? failure.message || t('common.error') : null;

  const loadBase = useCallback(() => {
    if (!id) return;
    Promise.all([
      api.customers.get(id),
      api.customers.listProjectLinks(id),
      api.projects.list({ active: true }),
      api.contacts.list(id).catch(() => [] as Contact[]),
      api.todos.list({ customerId: id }).catch(() => [] as Todo[]),
      api.recurringTasks.list({ customerId: id }).catch(() => [] as RecurringTask[]),
      api.knowledge.listForCustomer(id).catch(() => [] as Knowledge[]),
      api.manuals.listForCustomer(id).catch(() => [] as Manual[]),
      api.attachments.listForCustomer(id).catch(() => [] as Attachment[]),
      api.attachments.storageStatus().catch(() => ({ enabled: false })),
      api.environments.listForCustomer(id).catch(() => [] as Environment[]),
      api.secrets.listForCustomer(id).catch(() => [] as SecretListItem[]),
      api.harness.get({ scope: 'customer', customerId: id }).catch(() => null),
      api.activities.listForCustomer(id, 100).catch(() => [] as Activity[]),
      api.snippets.listForCustomer(id).catch(() => [] as Snippet[]),
      api.research.listForCustomer(id).catch(() => [] as ResearchEntry[]),
    ])
      .then(
        ([
          customerData,
          linkData,
          projectData,
          contactData,
          todoData,
          recurringData,
          knowledgeData,
          manualData,
          attachmentData,
          storageData,
          environmentData,
          secretData,
          harnessData,
          activityData,
          snippetData,
          researchData,
        ]) => {
          setFailure(null);
          setCustomer(customerData);
          setLinks(linkData);
          setProjects(projectData);
          setContacts(contactData);
          setCustomerTodos(todoData);
          setCustomerRecurring(recurringData);
          setCustomerKnowledge(knowledgeData);
          setCustomerManuals(manualData);
          setCustomerAttachments(attachmentData);
          setStorageEnabled(!!storageData?.enabled);
          setCustomerEnvironments(environmentData);
          setCustomerSecrets(secretData);
          setHarnessSections(harnessSectionCount(harnessData));
          setCustomerActivity(activityData);
          setCustomerSnippets(snippetData);
          setCustomerResearch(researchData);
        },
      )
      // Leerer Fallback: die lokalisierte Ersatzmeldung setzt das Rendering ein,
      // damit `t` keine Dependency von `loadBase` werden muss.
      .catch((err: unknown) => setFailure({ id, message: errorMessage(err, '') }))
      .finally(() => setLoadedId(id));
  }, [id]);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project._id, project])),
    [projects],
  );

  /*
   * Über den Join-Key memoisiert, nicht über `links`: `loadBase` liefert bei
   * jedem Refresh ein neues Array, die Projekt-IDs darin sind aber fast immer
   * dieselben. Vorher stand deshalb `linkedProjectIds.join('|')` direkt im
   * Dependency-Array des Aggregations-Effects (`exhaustive-deps`: komplexer
   * Ausdruck). Jetzt ist die *Identität* von `linkedProjectIds` selbst schon
   * an die ID-Liste gebunden — der Effect darf sie normal als Dependency
   * führen und feuert trotzdem nur, wenn sich die Liste wirklich ändert.
   */
  const linkedProjectIdsKey = useMemo(
    () => links.map((link) => link.projectId).join('|'),
    [links],
  );
  const linkedProjectIds = useMemo(
    () => (linkedProjectIdsKey === '' ? [] : linkedProjectIdsKey.split('|')),
    [linkedProjectIdsKey],
  );

  const linkedEnvIdsByLink = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of links) {
      map.set(link.projectId, new Set(link.environmentIds));
    }
    return map;
  }, [links]);

  /*
   * Das Aggregat trägt den Schlüssel der Projektliste, aus der es stammt.
   * Damit sind `aggregate` und `aggLoading` *abgeleitet* statt per Effect
   * gesetzt (`set-state-in-effect`) — und ein Aggregat aus einer inzwischen
   * veralteten Projektliste kann nicht mehr angezeigt werden. Vorher blieb
   * nach dem Entfernen einer Projekt-Verknüpfung das alte Aggregat inklusive
   * der Daten des entfernten Projekts stehen, bis der Nachlauf fertig war.
   */
  const [aggResult, setAggResult] = useState<{ key: string; data: AggregatedData }>({
    key: '',
    data: emptyAggregate,
  });
  const aggregate = aggResult.key === linkedProjectIdsKey ? aggResult.data : emptyAggregate;
  const aggLoading = linkedProjectIdsKey !== '' && aggResult.key !== linkedProjectIdsKey;

  useEffect(() => {
    if (linkedProjectIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      linkedProjectIds.map(async (pid) => {
        const [todos, knowledge, recurring, environments, secrets, attachments, activity] =
          await Promise.all([
            api.todos.list({ projectId: pid }).catch(() => []),
            api.knowledge.list(pid).catch(() => []),
            api.recurringTasks.list({ projectId: pid }).catch(() => []),
            api.environments.list(pid).catch(() => []),
            api.secrets.list(pid).catch(() => []),
            api.attachments.list(pid).catch(() => []),
            api.activities.list(pid, 50).catch(() => []),
          ]);
        return { todos, knowledge, recurring, environments, secrets, attachments, activity };
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const merged: AggregatedData = {
          todos: [],
          knowledge: [],
          recurring: [],
          environments: [],
          secrets: [],
          attachments: [],
          activity: [],
        };
        for (const r of results) {
          merged.todos.push(...r.todos);
          merged.knowledge.push(...r.knowledge);
          merged.recurring.push(...r.recurring);
          merged.environments.push(...r.environments);
          merged.secrets.push(...r.secrets);
          merged.attachments.push(...r.attachments);
          merged.activity.push(...r.activity);
        }
        merged.todos.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        merged.knowledge.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        merged.activity.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setAggResult({ key: linkedProjectIdsKey, data: merged });
      })
      // Die Einzelabrufe fangen ihre Fehler schon selbst ab; dieses `catch`
      // deckt nur den Rest. Es muss den Schlüssel trotzdem setzen, sonst
      // bliebe `aggLoading` (jetzt abgeleitet) dauerhaft true.
      .catch(() => {
        if (!cancelled) setAggResult({ key: linkedProjectIdsKey, data: emptyAggregate });
      });
    return () => {
      cancelled = true;
    };
  }, [linkedProjectIds, linkedProjectIdsKey]);

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">{t('common.errorLoading', { error })}</p>
      </div>
    );
  }
  if (!customer || !id) return <p className="text-red-400">{t('customers.notFound')}</p>;

  const openTodos = aggregate.todos.filter((todo) => todo.status !== 'done' && !todo.archived);
  const openCustomerTodos = customerTodos.filter((todo) => todo.status !== 'done' && !todo.archived);
  const linkedOnlyEnvironments = aggregate.environments.filter((env) => {
    if (!env.projectId) return false;
    const linked = linkedEnvIdsByLink.get(env.projectId);
    return linked ? linked.has(env._id) : false;
  });
  const linkedEnvIdSet = new Set(linkedOnlyEnvironments.map((env) => env._id));
  const linkedSecrets = aggregate.secrets.filter(
    (secret) => secret.environmentId === null || linkedEnvIdSet.has(secret.environmentId),
  );

  const navGroups: { label: string; items: { key: Tab; label: string; count?: number }[] }[] = [
    {
      label: t('sidebar.core'),
      items: [
        { key: 'overview', label: t('customers.tab.overview') },
        { key: 'projects', label: t('customers.tab.projects'), count: links.length },
        { key: 'todos', label: t('customers.tab.todos'), count: openCustomerTodos.length },
        { key: 'activity', label: t('customers.tab.activity'), count: customerActivity.length + aggregate.activity.length },
      ],
    },
    {
      label: t('sidebar.knowledge'),
      items: [
        { key: 'knowledge', label: t('customers.tab.knowledge'), count: customerKnowledge.length },
        { key: 'manual', label: t('customers.tab.manual'), count: customerManuals.length },
        { key: 'workflows', label: t('customers.tab.workflows'), count: customerRecurring.filter((rt) => rt.active).length },
        { key: 'files', label: t('customers.tab.files'), count: customerAttachments.length },
        { key: 'soul', label: t('customers.tab.soul'), count: harnessSections },
        { key: 'snippets', label: t('customers.tab.snippets'), count: customerSnippets.length },
        { key: 'research', label: t('customers.tab.research'), count: customerResearch.length },
      ],
    },
    {
      label: t('sidebar.system'),
      items: [
        { key: 'environments', label: t('customers.tab.environments'), count: customerEnvironments.length + linkedOnlyEnvironments.length },
        { key: 'secrets', label: t('customers.tab.secrets'), count: customerSecrets.length + linkedSecrets.length },
        { key: 'monitoring', label: t('customers.tab.monitoring') },
        { key: 'ssh', label: t('customers.tab.ssh') },
        { key: 'kube', label: t('customers.tab.kube') },
        { key: 'automation', label: t('nav.workflows') },
        { key: 'contacts', label: t('customers.tab.contacts'), count: contacts.length },
      ],
    },
  ];

  const allTabs = navGroups.flatMap((group) => group.items);
  const currentTab = allTabs.find((item) => item.key === tab);
  const currentTabLabel = currentTab?.label || tab;
  const currentTabCount = currentTab?.count;

  const sidebarNav = (onSelect?: () => void) => (
    <nav className="space-y-5">
      {navGroups.map((group) => (
        <div key={group.label}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-600 px-3 mb-1.5">
            {group.label}
          </h3>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => {
                    setTab(item.key);
                    onSelect?.();
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm rounded-lg flex justify-between items-center transition-colors ${
                    tab === item.key
                      ? 'bg-gray-800 text-cyan-400 font-medium'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  {typeof item.count === 'number' && (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ml-2 ${
                        tab === item.key ? 'bg-gray-700 text-cyan-400' : 'bg-gray-800/80 text-gray-500'
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  const removeProjectLink = async (linkId: string) => {
    if (!window.confirm(t('customers.linkUnlinkConfirm'))) return;
    try {
      await api.customers.deleteProjectLink(id, linkId);
      setLinks((current) => current.filter((link) => link._id !== linkId));
    } catch (err) {
      showError(errorMessage(err, t('customers.linkUnlinkFailed')));
    }
  };

  const archiveCustomer = async () => {
    if (!window.confirm(t('customers.archiveConfirm'))) return;
    setArchiving(true);
    try {
      const updated = await api.customers.archive(id);
      setCustomer(updated);
    } catch (err) {
      showError(errorMessage(err, t('customers.archiveFailed')));
    } finally {
      setArchiving(false);
    }
  };

  const restoreCustomer = async () => {
    setArchiving(true);
    try {
      const updated = await api.customers.update(id, { status: 'active' });
      setCustomer(updated);
    } catch (err) {
      showError(errorMessage(err, t('customers.restoreFailed')));
    } finally {
      setArchiving(false);
    }
  };

  const exportCustomer = async () => {
    try {
      const includeSecrets = window.confirm(t('customers.exportIncludeSecretsPrompt'));
      await api.customerTransfer.export(id, includeSecrets);
    } catch (err) {
      showError(errorMessage(err, t('common.error')));
    }
  };

  const isArchived = customer.status === 'archived';

  return (
    <div>
      <Link to="/customers" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; {t('customers.allCustomers')}
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
          <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{customer.name}</h1>
          <Badge color={statusColors[customer.status]} rounded="full">
            {t(`customers.status.${customer.status}`)}
          </Badge>
          <Link
            to={`/customers/${id}/edit`}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-full transition-colors"
          >
            {t('customers.edit')}
          </Link>
          {isArchived ? (
            <button
              type="button"
              onClick={() => { void restoreCustomer(); }}
              disabled={archiving}
              className="text-xs px-2 py-0.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-300 hover:text-emerald-200 rounded-full transition-colors disabled:opacity-50"
            >
              {t('customers.restoreCustomer')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void archiveCustomer(); }}
              disabled={archiving}
              className="text-xs px-2 py-0.5 bg-amber-900/30 hover:bg-amber-800/50 text-amber-400 hover:text-amber-200 rounded-full transition-colors disabled:opacity-50"
            >
              {t('customers.archive')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { void exportCustomer(); }}
            className="text-xs px-2 py-0.5 bg-violet-900/30 hover:bg-violet-800/50 text-violet-300 hover:text-violet-100 rounded-full transition-colors"
            title={t('customers.exportTitle')}
          >
            {t('customers.export')}
          </button>
        </div>
        {customer.description && (
          <div className="mb-2 text-gray-400">
            <Markdown>{customer.description}</Markdown>
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-500">
          {customer.website && <span>{t('customers.website')}: {customer.website}</span>}
          {customer.primaryContactName && <span>{t('customers.primaryContact')}: {customer.primaryContactName}</span>}
          <span>{t('common.created')}: {new Date(customer.createdAt).toLocaleDateString(dateLocale)}</span>
          <span>{t('common.updated')}: {new Date(customer.updatedAt).toLocaleDateString(dateLocale)}</span>
        </div>
        {customer.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {customer.tags.map((tag) => (
              <Badge key={tag} color="bg-violet-900/40 text-cyan-300">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        className="lg:hidden mb-4 flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4"
        >
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
        <span>{currentTabLabel}</span>
      </button>

      {sidebarOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
          <div
            className="fixed inset-y-0 left-0 w-64 bg-gray-900 border-r border-gray-800 z-50 lg:hidden overflow-y-auto"
            style={{
              paddingTop: 'max(1rem, var(--sat))',
              paddingBottom: 'max(1rem, var(--sab))',
              paddingLeft: 'max(0.75rem, var(--sal))',
            }}
          >
            <div className="flex items-center justify-between px-3 mb-4 pr-4">
              <span className="text-sm font-semibold text-gray-300">{customer.name}</span>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="text-gray-500 hover:text-gray-300 p-1"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {sidebarNav(() => setSidebarOpen(false))}
          </div>
        </>
      )}

      <div className="flex gap-6">
        <div className="hidden lg:block shrink-0 w-52 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto">
          {sidebarNav()}
        </div>
        <div className="flex-1 min-w-0">
          <ProjectTabShell title={currentTabLabel} count={currentTabCount}>
            {tab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-300 mb-2">{t('customers.customerFile')}</h3>
                  {customer.notes ? (
                    <div className="text-gray-400">
                      <Markdown>{customer.notes}</Markdown>
                    </div>
                  ) : (
                    <EmptyState message={t('customers.noNotes')} />
                  )}
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-300">{t('customers.quickFacts')}</h3>
                  <div className="text-sm text-gray-500 space-y-2">
                    <p>
                      {t('customers.linkedProjects')}: <span className="text-gray-300">{links.length}</span>
                    </p>
                    <p>
                      {t('customers.openCustomerTodos')}:{' '}
                      <span className="text-gray-300">{openCustomerTodos.length}</span>
                    </p>
                    <p className="text-xs text-gray-600">
                      {t('customers.openProjectTodosAggregated', { count: openTodos.length })}
                    </p>
                    <p>
                      {t('customers.tab.workflows')}:{' '}
                      <span className="text-gray-300">{customerRecurring.filter((rt) => rt.active).length}</span>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'projects' && (
              <ProjectsTab
                customerId={id}
                links={links}
                projectsById={projectsById}
                onUnlink={(linkId) => { void removeProjectLink(linkId); }}
                onAddLink={() => { void navigate(`/customers/${id}/links/new`); }}
                allLinked={links.length >= projects.length}
              />
            )}

            {tab === 'todos' && (
              <CustomerQuestsTab
                customerId={id}
                todos={customerTodos}
                aggregatedTodos={openTodos}
                projectsById={projectsById}
                onUpdate={loadBase}
                aggLoading={aggLoading}
              />
            )}

            {tab === 'knowledge' && (
              <CustomerLoreTab
                customerId={id}
                entries={customerKnowledge}
                aggregatedEntries={aggregate.knowledge}
                projectsById={projectsById}
                onUpdate={loadBase}
                aggLoading={aggLoading}
              />
            )}

            {tab === 'manual' && (
              <CustomerManualTab
                customerId={id}
                entries={customerManuals}
                onUpdate={loadBase}
                linkedProjectIds={linkedProjectIds}
                projectsById={projectsById}
              />
            )}

            {tab === 'workflows' && (
              <CustomerRitualsTab
                customerId={id}
                rituals={customerRecurring}
                aggregatedRituals={aggregate.recurring.filter((rt) => rt.active)}
                projectsById={projectsById}
                aggLoading={aggLoading}
              />
            )}

            {tab === 'environments' && (
              <CustomerEnvironmentsTab
                customerId={id}
                aggregated={linkedOnlyEnvironments}
                projectsById={projectsById}
                aggLoading={aggLoading}
              />
            )}

            {tab === 'secrets' && (
              <CustomerSecretsTab
                customerId={id}
                aggregated={linkedSecrets}
                projectsById={projectsById}
                aggLoading={aggLoading}
              />
            )}

            {tab === 'files' && (
              <CustomerFilesTab
                customerId={id}
                items={customerAttachments}
                aggregatedItems={aggregate.attachments}
                projectsById={projectsById}
                aggLoading={aggLoading}
                storageEnabled={storageEnabled}
                onUpdate={loadBase}
              />
            )}

            {tab === 'monitoring' && (
              <MonitoringTab
                customerId={id}
                projectsById={projectsById}
                linkedProjectIds={linkedProjectIds}
              />
            )}

            {tab === 'ssh' && (
              <SshConnectionsTab scope={{ customerId: id }} />
            )}

            {tab === 'kube' && (
              <KubeClustersTab scope={{ customerId: id }} />
            )}

            {tab === 'automation' && (
              <WorkflowProjectTab scope="customer" customerId={id} />
            )}

            {tab === 'contacts' && (
              <ContactsTab
                customer={customer}
                customerId={id}
                contacts={contacts}
                onChanged={loadBase}
              />
            )}

            {tab === 'activity' && (
              <AggregatedActivityTab
                items={[...customerActivity, ...aggregate.activity].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {/*
              Kundenebene: kein `resolveProjectId` — eine Auflösung gibt es nur
              aus Sicht eines Projekts, nicht aus Sicht eines Kunden. Die
              Komponente zeigt hier folgerichtig nur den Editor.
            */}
            {tab === 'soul' && <HarnessView owner={{ scope: 'customer', customerId: id }} />}

            {tab === 'snippets' && (
              <SnippetList
                entries={customerSnippets}
                customerId={id}
                onUpdate={loadBase}
              />
            )}

            {tab === 'research' && (
              <ResearchList
                entries={customerResearch}
                customerId={id}
                onUpdate={loadBase}
              />
            )}
          </ProjectTabShell>
        </div>
      </div>
    </div>
  );
}

function ProjectsTab({
  customerId,
  links,
  projectsById,
  onUnlink,
  onAddLink,
  allLinked,
}: {
  customerId: string;
  links: CustomerProjectLink[];
  projectsById: Map<string, Project>;
  onUnlink: (linkId: string) => void;
  onAddLink: () => void;
  allLinked: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" variant="primary" onClick={onAddLink} disabled={allLinked}>
          {t('customers.linkProject')}
        </Button>
      </div>
      {links.length === 0 ? (
        <EmptyState message={t('customers.noProjectLinks')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {links.map((link) => {
            const project = projectsById.get(link.projectId);
            return (
              <div key={link._id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {project ? (
                      <Link to={`/projects/${project._id}`} className="font-semibold text-gray-100 hover:text-cyan-300">
                        {project.name}
                      </Link>
                    ) : (
                      <p className="font-semibold text-gray-500">{link.projectId}</p>
                    )}
                    {link.role && <p className="text-xs text-cyan-400 mt-1">{link.role}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      to={`/customers/${customerId}/links/${link._id}/edit`}
                      className="text-xs text-gray-500 hover:text-cyan-300"
                    >
                      {t('customers.edit')}
                    </Link>
                    <button
                      type="button"
                      onClick={() => onUnlink(link._id)}
                      className="text-xs text-gray-500 hover:text-red-300"
                    >
                      {t('common.remove')}
                    </button>
                  </div>
                </div>
                {link.notes && <p className="text-sm text-gray-500 mt-3">{link.notes}</p>}
                <div className="flex flex-wrap gap-2 mt-3 text-xs text-gray-600">
                  <span>{t('common.status')}: {link.status}</span>
                  <span>{t('customers.environmentsLinked')}: {link.environmentIds.length}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectBadge({ project, projectId }: { project?: Project; projectId?: string }) {
  if (project) {
    return (
      <Link to={`/projects/${project._id}`} className="text-xs px-1.5 py-0.5 rounded bg-violet-900/40 text-cyan-300 hover:bg-violet-900/70">
        {project.name}
      </Link>
    );
  }
  if (!projectId) {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300">customer</span>;
  }
  return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">{projectId}</span>;
}

function CustomerQuestsTab({
  customerId,
  todos,
  aggregatedTodos,
  projectsById,
  onUpdate,
  aggLoading,
}: {
  customerId: string;
  todos: Todo[];
  aggregatedTodos: Todo[];
  projectsById: Map<string, Project>;
  onUpdate: () => void;
  aggLoading: boolean;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  return (
    <div className="space-y-6">
      <TodoBoard todos={todos} milestones={[]} customerId={customerId} onUpdate={onUpdate} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoOpenInProjects', { count: aggregatedTodos.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedTodosTab
              todos={aggregatedTodos}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AggregatedTodosTab({
  todos,
  projectsById,
  loading,
}: {
  todos: Todo[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && todos.length === 0) return <LoadingText />;
  if (todos.length === 0) return <EmptyState message={t('customers.noLinkedTodos')} />;
  return (
    <div className="space-y-2">
      {todos.map((todo) => {
        const project = todo.projectId ? projectsById.get(todo.projectId) : undefined;
        const detailHref = project
          ? `/projects/${project._id}/todos/${todo._id}`
          : todo.projectId
            ? `/projects/${todo.projectId}`
            : `/customers/${todo.customerId}/todos/${todo._id}`;
        return (
          <Link
            key={todo._id}
            to={detailHref}
            className="block bg-gray-900 border border-gray-800 rounded-lg p-3 hover:border-violet-700 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {todo.displayNumber && (
                    <span className="text-xs text-gray-600 font-mono">{todo.displayNumber}</span>
                  )}
                  <span className="text-sm text-gray-100 truncate">{todo.title}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {todo.projectId && (
                    <ProjectBadge project={project} projectId={todo.projectId} />
                  )}
                  <Badge color="bg-gray-800 text-gray-400">{todo.status}</Badge>
                  <Badge color="bg-gray-800 text-gray-400">{todo.priority}</Badge>
                </div>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function CustomerLoreTab({
  customerId,
  entries,
  aggregatedEntries,
  projectsById,
  onUpdate,
  aggLoading,
}: {
  customerId: string;
  entries: Knowledge[];
  aggregatedEntries: Knowledge[];
  projectsById: Map<string, Project>;
  onUpdate: () => void;
  aggLoading: boolean;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  return (
    <div className="space-y-6">
      <KnowledgeList entries={entries} customerId={customerId} onUpdate={onUpdate} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoLoreInProjects', { count: aggregatedEntries.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedKnowledgeTab
              items={aggregatedEntries}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AggregatedKnowledgeTab({
  items,
  projectsById,
  loading,
}: {
  items: Knowledge[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedKnowledge')} />;
  return (
    <div className="space-y-2">
      {items.map((entry) => {
        const project = entry.projectId ? projectsById.get(entry.projectId) : undefined;
        return (
          <div key={entry._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-100">{entry.topic}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {entry.projectId && <ProjectBadge project={project} projectId={entry.projectId} />}
                  {entry.category && <Badge color="bg-gray-800 text-gray-400">{entry.category}</Badge>}
                  {entry.scope === 'global' && <Badge color="bg-blue-900/40 text-blue-300">global</Badge>}
                </div>
                <p className="text-xs text-gray-500 mt-2 line-clamp-2">{entry.content.slice(0, 200)}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CustomerRitualsTab({
  customerId,
  rituals,
  aggregatedRituals,
  projectsById,
  aggLoading,
}: {
  customerId: string;
  rituals: RecurringTask[];
  aggregatedRituals: RecurringTask[];
  projectsById: Map<string, Project>;
  aggLoading: boolean;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  return (
    <div className="space-y-6">
      <RecurringTaskList entries={rituals} customerId={customerId} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoActiveInProjects', { count: aggregatedRituals.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedRecurringTab
              items={aggregatedRituals}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AggregatedRecurringTab({
  items,
  projectsById,
  loading,
}: {
  items: RecurringTask[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedRecurring')} />;
  return (
    <div className="space-y-2">
      {items.map((rt) => {
        const project = rt.projectId ? projectsById.get(rt.projectId) : undefined;
        const detailHref = rt.customerId
          ? `/customers/${rt.customerId}/recurring-tasks/${rt._id}`
          : rt.projectId
            ? `/projects/${rt.projectId}/recurring-tasks/${rt._id}`
            : `/recurring-tasks/${rt._id}`;
        return (
          <Link
            key={rt._id}
            to={detailHref}
            className="block bg-gray-900 border border-gray-800 rounded-lg p-3 hover:border-violet-700 transition-colors"
          >
            <p className="text-sm text-gray-100">{rt.title}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {rt.projectId && <ProjectBadge project={project} projectId={rt.projectId} />}
              <Badge color="bg-gray-800 text-gray-400">{rt.frequency}</Badge>
              {rt.nextRun && (
                <span className="text-xs text-gray-500">→ {new Date(rt.nextRun).toLocaleDateString()}</span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function AggregatedEnvironmentsTab({
  items,
  projectsById,
  loading,
}: {
  items: Environment[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedEnvironments')} />;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {items.map((env) => {
        const project = env.projectId ? projectsById.get(env.projectId) : undefined;
        return (
          <div key={env._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-100">{env.name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {env.projectId && <ProjectBadge project={project} projectId={env.projectId} />}
                  {!env.active && <Badge color="bg-gray-800 text-gray-500">inactive</Badge>}
                </div>
                {env.description && <p className="text-xs text-gray-500 mt-2">{env.description}</p>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AggregatedSecretsTab({
  items,
  projectsById,
  loading,
}: {
  items: SecretListItem[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedSecrets')} />;
  return (
    <div className="space-y-2">
      {items.map((secret) => {
        const project = secret.projectId ? projectsById.get(secret.projectId) : undefined;
        return (
          <div key={secret._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center gap-3">
            <span className="text-sm font-mono text-gray-100 truncate">{secret.key}</span>
            <Badge color="bg-gray-800 text-gray-400">{secret.type}</Badge>
            {secret.projectId && <ProjectBadge project={project} projectId={secret.projectId} />}
            {secret.description && <span className="text-xs text-gray-500 truncate">— {secret.description}</span>}
          </div>
        );
      })}
    </div>
  );
}

function AggregatedAttachmentsTab({
  items,
  projectsById,
  loading,
}: {
  items: Attachment[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedFiles')} />;
  return (
    <div className="space-y-2">
      {items.map((file) => {
        const project = file.projectId ? projectsById.get(file.projectId) : undefined;
        return (
          <div key={file._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center gap-3">
            <span className="text-sm text-gray-100 truncate min-w-0">{file.originalName}</span>
            <Badge color="bg-gray-800 text-gray-400">{file.mimeType}</Badge>
            {file.projectId && <ProjectBadge project={project} projectId={file.projectId} />}
          </div>
        );
      })}
    </div>
  );
}

function CustomerEnvironmentsTab({
  customerId,
  aggregated,
  projectsById,
  aggLoading,
}: {
  customerId: string;
  aggregated: Environment[];
  projectsById: Map<string, Project>;
  aggLoading: boolean;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  return (
    <div className="space-y-6">
      <EnvironmentList customerId={customerId} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoEnvsInProjects', { count: aggregated.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedEnvironmentsTab
              items={aggregated}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerSecretsTab({
  customerId,
  aggregated,
  projectsById,
  aggLoading,
}: {
  customerId: string;
  aggregated: SecretListItem[];
  projectsById: Map<string, Project>;
  aggLoading: boolean;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  return (
    <div className="space-y-6">
      <SecretsList customerId={customerId} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoSecretsInProjects', { count: aggregated.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedSecretsTab
              items={aggregated}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerManualTab({
  customerId,
  entries,
  onUpdate,
  linkedProjectIds,
  projectsById,
}: {
  customerId: string;
  entries: Manual[];
  onUpdate: () => void;
  linkedProjectIds: string[];
  projectsById: Map<string, Project>;
}) {
  const { t } = useTranslation();
  const [showAggregated, setShowAggregated] = useState(false);
  /*
   * Wie im Eltern-Aggregat: das Ergebnis trägt den Schlüssel der Projektliste,
   * aus der es stammt. `aggregatedEntries` und `aggLoading` sind damit
   * abgeleitet (`set-state-in-effect`) und können keine Handbuch-Einträge
   * eines inzwischen entfernten Projekts mehr zeigen.
   */
  const aggKey = linkedProjectIds.join('|');
  const [aggResult, setAggResult] = useState<{ key: string; entries: Manual[] } | null>(null);
  const aggregatedEntries = aggResult !== null && aggResult.key === aggKey ? aggResult.entries : [];
  const aggLoading = showAggregated && aggKey !== '' && aggResult?.key !== aggKey;

  useEffect(() => {
    if (!showAggregated || linkedProjectIds.length === 0) return;
    let cancelled = false;
    const key = linkedProjectIds.join('|');
    Promise.all(linkedProjectIds.map((pid) => api.manuals.list(pid).catch(() => [] as Manual[])))
      .then((results) => {
        if (cancelled) return;
        const merged = results.flat();
        merged.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        setAggResult({ key, entries: merged });
      })
      // Muss den Schlüssel auch im Fehlerfall setzen, sonst bliebe das
      // abgeleitete `aggLoading` dauerhaft true.
      .catch(() => {
        if (!cancelled) setAggResult({ key, entries: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [showAggregated, linkedProjectIds]);

  return (
    <div className="space-y-6">
      <ManualView customerId={customerId} entries={entries} onUpdate={onUpdate} />
      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoManualInProjects', { count: aggregatedEntries.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            {aggLoading && aggregatedEntries.length === 0 ? (
              <LoadingText />
            ) : aggregatedEntries.length === 0 ? (
              <EmptyState message={t('customers.noLinkedManual')} />
            ) : (
              <div className="space-y-2">
                {aggregatedEntries.map((m) => {
                  const project = m.projectId ? projectsById.get(m.projectId) : undefined;
                  return (
                    <div key={m._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-100">{m.title}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {m.projectId && <ProjectBadge project={project} projectId={m.projectId} />}
                            {m.category && <Badge color="bg-gray-800 text-gray-400">{m.category}</Badge>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerFilesTab({
  customerId,
  items,
  aggregatedItems,
  projectsById,
  aggLoading,
  storageEnabled,
  onUpdate,
}: {
  customerId: string;
  items: Attachment[];
  aggregatedItems: Attachment[];
  projectsById: Map<string, Project>;
  aggLoading: boolean;
  storageEnabled: boolean;
  onUpdate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [showAggregated, setShowAggregated] = useState(false);
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const handleDelete = async (file: Attachment) => {
    try {
      await api.attachments.delete(file._id);
      onUpdate();
    } catch (err) {
      showError(errorMessage(err, t('common.errorDeleting')));
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      {storageEnabled ? (
        <FileUploadZone customerId={customerId} onUploadComplete={onUpdate} />
      ) : (
        <div className="bg-amber-900/20 border border-amber-800/40 rounded-lg p-3 text-sm text-amber-300">
          {t('customers.filesDisabled')}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState message={t('customers.noCustomerFiles')} />
      ) : (
        <div className="space-y-2">
          {items.map((file) => (
            <div
              key={file._id}
              className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex flex-wrap items-center gap-3"
            >
              <span className="text-sm text-gray-100 truncate min-w-0 flex-1">{file.originalName}</span>
              <Badge color="bg-gray-800 text-gray-400">{file.mimeType}</Badge>
              <span className="text-xs text-gray-500 whitespace-nowrap">{formatSize(file.size)}</span>
              <span className="text-xs text-gray-600 whitespace-nowrap">
                {new Date(file.createdAt).toLocaleDateString(dateLocale)}
              </span>
              <a
                href={api.attachments.downloadUrl(file._id)}
                target="_blank"
                rel="noreferrer"
                className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-cyan-300 rounded transition-colors"
              >
                {t('customers.downloadFile')}
              </a>
              <ConfirmButton
                onConfirm={() => handleDelete(file)}
                label={t('common.delete')}
                confirmLabel={t('common.confirmDeleteLong')}
                size="xs"
              />
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAggregated((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAggregated ? '▾' : '▸'}{' '}
          {t('customers.alsoFilesInProjects', { count: aggregatedItems.length })}
        </button>
        {showAggregated && (
          <div className="mt-3">
            <AggregatedAttachmentsTab
              items={aggregatedItems}
              projectsById={projectsById}
              loading={aggLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AggregatedActivityTab({
  items,
  projectsById,
  loading,
}: {
  items: Activity[];
  projectsById: Map<string, Project>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading && items.length === 0) return <LoadingText />;
  if (items.length === 0) return <EmptyState message={t('customers.noLinkedActivity')} />;
  return (
    <div className="space-y-1.5">
      {items.slice(0, 100).map((act) => {
        const project = act.projectId ? projectsById.get(act.projectId) : undefined;
        return (
          <div key={act._id} className="flex items-center gap-2 text-xs text-gray-400 flex-wrap">
            <span className="text-gray-600 font-mono whitespace-nowrap">
              {new Date(act.createdAt).toLocaleString()}
            </span>
            <ProjectBadge project={project} projectId={act.projectId} />
            <span className="text-gray-300">{act.entity}/{act.action}</span>
            {act.summary && <span className="text-gray-500 truncate min-w-0">— {act.summary}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ContactsTab({
  customer,
  customerId,
  contacts,
  onChanged,
}: {
  customer: Customer;
  customerId: string;
  contacts: Contact[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const navigate = useNavigate();

  const hasLegacy =
    customer.primaryContactName ||
    customer.primaryContactEmail ||
    customer.primaryContactPhone ||
    customer.website;

  const removeContact = async (contactId: string, name: string) => {
    if (!window.confirm(t('contacts.deleteConfirm', { name }))) return;
    try {
      await api.contacts.remove(customerId, contactId);
      onChanged();
    } catch (err) {
      showError(errorMessage(err, t('contacts.deleteFailed')));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="primary"
          onClick={() => { void navigate(`/customers/${customerId}/contacts/new`); }}
        >
          {t('contacts.newContact')}
        </Button>
      </div>

      {hasLegacy && (
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4 space-y-2 text-sm">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
            {t('contacts.quickAccess')}
          </h3>
          {customer.primaryContactName && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-32 shrink-0">{t('customers.primaryContact')}</span>
              <span className="text-gray-100">{customer.primaryContactName}</span>
            </div>
          )}
          {customer.primaryContactEmail && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-32 shrink-0">{t('customers.primaryContactEmail')}</span>
              <a className="text-cyan-300 hover:text-cyan-200" href={`mailto:${customer.primaryContactEmail}`}>
                {customer.primaryContactEmail}
              </a>
            </div>
          )}
          {customer.primaryContactPhone && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-32 shrink-0">{t('customers.primaryContactPhone')}</span>
              <a className="text-cyan-300 hover:text-cyan-200" href={`tel:${customer.primaryContactPhone}`}>
                {customer.primaryContactPhone}
              </a>
            </div>
          )}
          {customer.website && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-32 shrink-0">{t('customers.website')}</span>
              <a
                className="text-cyan-300 hover:text-cyan-200 break-all"
                href={customer.website.startsWith('http') ? customer.website : `https://${customer.website}`}
                target="_blank"
                rel="noreferrer"
              >
                {customer.website}
              </a>
            </div>
          )}
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyState message={t('contacts.noContacts')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {contacts.map((contact) => (
            <div key={contact._id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold text-gray-100">{contact.name}</h4>
                    {contact.isPrimary && (
                      <Badge color="bg-amber-900/40 text-amber-300" rounded="full">
                        {t('contacts.primary')}
                      </Badge>
                    )}
                  </div>
                  {contact.role && <p className="text-xs text-cyan-400 mt-0.5">{contact.role}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    to={`/customers/${customerId}/contacts/${contact._id}/edit`}
                    className="text-xs text-gray-500 hover:text-cyan-300"
                  >
                    {t('common.edit')}
                  </Link>
                  <button
                    type="button"
                    onClick={() => { void removeContact(contact._id, contact.name); }}
                    className="text-xs text-gray-500 hover:text-red-300"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-sm">
                {contact.email && (
                  <a
                    className="block text-cyan-300 hover:text-cyan-200 break-all"
                    href={`mailto:${contact.email}`}
                  >
                    {contact.email}
                  </a>
                )}
                {contact.phone && (
                  <a
                    className="block text-cyan-300 hover:text-cyan-200"
                    href={`tel:${contact.phone}`}
                  >
                    {contact.phone}
                  </a>
                )}
              </div>
              {contact.notes && (
                <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{contact.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
