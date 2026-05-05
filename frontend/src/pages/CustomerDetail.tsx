import { useEffect, useMemo, useState } from 'react';
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
  Project,
  RecurringTask,
  SecretListItem,
  Todo,
  api,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Markdown from '../components/Markdown';
import ProjectTabShell from '../components/ui/ProjectTabShell';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';

type Tab =
  | 'overview'
  | 'projects'
  | 'todos'
  | 'knowledge'
  | 'workflows'
  | 'environments'
  | 'secrets'
  | 'files'
  | 'monitoring'
  | 'contacts'
  | 'activity';

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
  const [aggregate, setAggregate] = useState<AggregatedData>(emptyAggregate);
  const [tab, setTab] = useState<Tab>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aggLoading, setAggLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  const loadBase = () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    Promise.all([
      api.customers.get(id),
      api.customers.listProjectLinks(id),
      api.projects.list({ active: true }),
      api.contacts.list(id).catch(() => [] as Contact[]),
    ])
      .then(([customerData, linkData, projectData, contactData]) => {
        setCustomer(customerData);
        setLinks(linkData);
        setProjects(projectData);
        setContacts(contactData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadBase();
  }, [id]);

  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project._id, project])),
    [projects],
  );

  const linkedProjectIds = useMemo(() => links.map((link) => link.projectId), [links]);

  const linkedEnvIdsByLink = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of links) {
      map.set(link.projectId, new Set(link.environmentIds));
    }
    return map;
  }, [links]);

  useEffect(() => {
    if (linkedProjectIds.length === 0) {
      setAggregate(emptyAggregate);
      return;
    }
    let cancelled = false;
    setAggLoading(true);
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
        setAggregate(merged);
      })
      .finally(() => {
        if (!cancelled) setAggLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedProjectIds.join('|')]);

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
  const linkedOnlyEnvironments = aggregate.environments.filter((env) => {
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
        { key: 'todos', label: t('customers.tab.todos'), count: openTodos.length },
        { key: 'activity', label: t('customers.tab.activity'), count: aggregate.activity.length },
      ],
    },
    {
      label: t('sidebar.knowledge'),
      items: [
        { key: 'knowledge', label: t('customers.tab.knowledge'), count: aggregate.knowledge.length },
        { key: 'workflows', label: t('customers.tab.workflows'), count: aggregate.recurring.filter((rt) => rt.active).length },
        { key: 'files', label: t('customers.tab.files'), count: aggregate.attachments.length },
      ],
    },
    {
      label: t('sidebar.system'),
      items: [
        { key: 'environments', label: t('customers.tab.environments'), count: linkedOnlyEnvironments.length },
        { key: 'secrets', label: t('customers.tab.secrets'), count: linkedSecrets.length },
        { key: 'monitoring', label: t('customers.tab.monitoring') },
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
    } catch (err: any) {
      showError(err.message || t('customers.linkUnlinkFailed'));
    }
  };

  const archiveCustomer = async () => {
    if (!window.confirm(t('customers.archiveConfirm'))) return;
    setArchiving(true);
    try {
      const updated = await api.customers.archive(id);
      setCustomer(updated);
    } catch (err: any) {
      showError(err.message || t('customers.archiveFailed'));
    } finally {
      setArchiving(false);
    }
  };

  const restoreCustomer = async () => {
    setArchiving(true);
    try {
      const updated = await api.customers.update(id, { status: 'active' });
      setCustomer(updated);
    } catch (err: any) {
      showError(err.message || t('customers.restoreFailed'));
    } finally {
      setArchiving(false);
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
              onClick={restoreCustomer}
              disabled={archiving}
              className="text-xs px-2 py-0.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-300 hover:text-emerald-200 rounded-full transition-colors disabled:opacity-50"
            >
              {t('customers.restoreCustomer')}
            </button>
          ) : (
            <button
              type="button"
              onClick={archiveCustomer}
              disabled={archiving}
              className="text-xs px-2 py-0.5 bg-amber-900/30 hover:bg-amber-800/50 text-amber-400 hover:text-amber-200 rounded-full transition-colors disabled:opacity-50"
            >
              {t('customers.archive')}
            </button>
          )}
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
                      <span className="text-gray-300">{openTodos.length}</span>
                    </p>
                    <p>
                      {t('customers.tab.workflows')}:{' '}
                      <span className="text-gray-300">{aggregate.recurring.filter((rt) => rt.active).length}</span>
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
                onUnlink={removeProjectLink}
                onAddLink={() => navigate(`/customers/${id}/links/new`)}
                allLinked={links.length >= projects.length}
              />
            )}

            {tab === 'todos' && (
              <AggregatedTodosTab
                todos={openTodos}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'knowledge' && (
              <AggregatedKnowledgeTab
                items={aggregate.knowledge}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'workflows' && (
              <AggregatedRecurringTab
                items={aggregate.recurring.filter((rt) => rt.active)}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'environments' && (
              <AggregatedEnvironmentsTab
                items={linkedOnlyEnvironments}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'secrets' && (
              <AggregatedSecretsTab
                items={linkedSecrets}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'files' && (
              <AggregatedAttachmentsTab
                items={aggregate.attachments}
                projectsById={projectsById}
                loading={aggLoading}
              />
            )}

            {tab === 'monitoring' && (
              <EmptyState message={t('customers.monitoringPlanned')} />
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
                items={aggregate.activity}
                projectsById={projectsById}
                loading={aggLoading}
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

function ProjectBadge({ project, projectId }: { project?: Project; projectId: string }) {
  if (project) {
    return (
      <Link to={`/projects/${project._id}`} className="text-xs px-1.5 py-0.5 rounded bg-violet-900/40 text-cyan-300 hover:bg-violet-900/70">
        {project.name}
      </Link>
    );
  }
  return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">{projectId}</span>;
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
        const project = projectsById.get(todo.projectId);
        return (
          <Link
            key={todo._id}
            to={project ? `/projects/${project._id}/todos/${todo._id}` : `/projects/${todo.projectId}`}
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
                  <ProjectBadge project={project} projectId={todo.projectId} />
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
        const project = projectsById.get(rt.projectId);
        return (
          <Link
            key={rt._id}
            to={`/projects/${rt.projectId}/recurring-tasks/${rt._id}`}
            className="block bg-gray-900 border border-gray-800 rounded-lg p-3 hover:border-violet-700 transition-colors"
          >
            <p className="text-sm text-gray-100">{rt.title}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <ProjectBadge project={project} projectId={rt.projectId} />
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
        const project = projectsById.get(env.projectId);
        return (
          <div key={env._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-100">{env.name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <ProjectBadge project={project} projectId={env.projectId} />
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
        const project = projectsById.get(secret.projectId);
        return (
          <div key={secret._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center gap-3">
            <span className="text-sm font-mono text-gray-100 truncate">{secret.key}</span>
            <Badge color="bg-gray-800 text-gray-400">{secret.type}</Badge>
            <ProjectBadge project={project} projectId={secret.projectId} />
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
        const project = projectsById.get(file.projectId);
        return (
          <div key={file._id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center gap-3">
            <span className="text-sm text-gray-100 truncate min-w-0">{file.originalName}</span>
            <Badge color="bg-gray-800 text-gray-400">{file.mimeType}</Badge>
            <ProjectBadge project={project} projectId={file.projectId} />
          </div>
        );
      })}
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
        const project = projectsById.get(act.projectId);
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
    } catch (err: any) {
      showError(err.message || t('contacts.deleteFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="primary"
          onClick={() => navigate(`/customers/${customerId}/contacts/new`)}
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
                    onClick={() => removeContact(contact._id, contact.name)}
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
