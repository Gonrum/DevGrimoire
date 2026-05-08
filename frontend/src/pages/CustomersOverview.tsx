import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Customer, CustomerStatus } from '../api/client';
import ButtonLink from '../components/ui/ButtonLink';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import Markdown from '../components/Markdown';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';

const statusColors: Record<CustomerStatus, string> = {
  lead: 'bg-blue-900/50 text-blue-300',
  onboarding: 'bg-cyan-900/50 text-cyan-300',
  active: 'bg-green-900 text-green-300',
  paused: 'bg-yellow-900/50 text-yellow-300',
  offboarding: 'bg-orange-900/50 text-orange-300',
  cancelled: 'bg-red-900/50 text-red-300',
  archived: 'bg-gray-800 text-gray-500',
};

interface DashboardStats {
  openTodoCount: number;
  projectCount: number;
}

export default function CustomersOverview() {
  const { t, i18n } = useTranslation();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CustomerStatus | 'all'>('all');
  const [summary, setSummary] = useState<{
    totalActive: number;
    withOpenTodos: number;
    withoutProjects: number;
    recentlyUpdated: number;
  } | null>(null);
  const [statsByCustomer, setStatsByCustomer] = useState<Record<string, DashboardStats>>({});
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();

  const loadCustomers = () => {
    api.customers
      .list({ includeArchived: status === 'archived', status: status === 'all' ? undefined : status })
      .then(setCustomers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadDashboard = () => {
    api.customers
      .dashboard()
      .then((res) => {
        setSummary(res.summary);
        const map: Record<string, DashboardStats> = {};
        for (const entry of res.customers) {
          map[entry.customerId] = {
            openTodoCount: entry.openTodoCount,
            projectCount: entry.projectCount,
          };
        }
        setStatsByCustomer(map);
      })
      .catch(() => {
        // Dashboard ist non-critical: bei Fehler lädt der Rest weiterhin.
        setSummary(null);
        setStatsByCustomer({});
      });
  };

  useEffect(() => {
    loadCustomers();
  }, [status]);

  useEffect(() => {
    loadDashboard();
  }, []);

  const filteredCustomers = customers.filter((customer) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      customer.name.toLowerCase().includes(q) ||
      customer.description?.toLowerCase().includes(q) ||
      customer.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">{t('common.errorLoading', { error })}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold mb-6 font-grimoire">{t('customers.overview')}</h1>

      {summary && summary.totalActive > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KpiTile label={t('customers.dashboard.totalActive')} value={summary.totalActive} tone="default" />
          <KpiTile
            label={t('customers.dashboard.withOpenTodos')}
            value={summary.withOpenTodos}
            tone={summary.withOpenTodos > 0 ? 'amber' : 'default'}
          />
          <KpiTile
            label={t('customers.dashboard.withoutProjects')}
            value={summary.withoutProjects}
            tone={summary.withoutProjects > 0 ? 'rose' : 'default'}
          />
          <KpiTile
            label={t('customers.dashboard.recentlyUpdated')}
            value={summary.recentlyUpdated}
            tone="default"
          />
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <ButtonLink to="/customers/new" variant="primary" size="lg" className="mb-0 justify-center">
          {t('customers.newCustomer')}
        </ButtonLink>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {importing ? t('customers.importing') : t('customers.importJson')}
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
              const result = await api.customerTransfer.import(file);
              if (result.warnings.length > 0) {
                showSuccess(t('customers.importPartial', { count: result.warnings.length }));
              } else {
                showSuccess(t('customers.importSuccess'));
              }
              navigate(`/customers/${result.customerId}`);
            } catch (err) {
              showError(err instanceof Error ? err.message : t('customers.importFailed'));
            } finally {
              setImporting(false);
              e.target.value = '';
            }
          }}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as CustomerStatus | 'all')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 w-full sm:w-44"
        >
          <option value="all">{t('customers.status.all')}</option>
          <option value="lead">{t('customers.status.lead')}</option>
          <option value="onboarding">{t('customers.status.onboarding')}</option>
          <option value="active">{t('customers.status.active')}</option>
          <option value="paused">{t('customers.status.paused')}</option>
          <option value="offboarding">{t('customers.status.offboarding')}</option>
          <option value="cancelled">{t('customers.status.cancelled')}</option>
          <option value="archived">{t('customers.status.archived')}</option>
        </select>
        <input
          type="text"
          placeholder={t('customers.searchCustomers')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-full sm:w-64"
        />
      </div>
      {customers.length === 0 ? (
        <EmptyState message={t('customers.noCustomers')} />
      ) : filteredCustomers.length === 0 ? (
        <EmptyState message={t('customers.noCustomersFound', { search })} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.map((customer) => (
            <Link
              key={customer._id}
              to={`/customers/${customer._id}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-violet-500 transition-colors"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <h2 className="text-lg font-semibold min-w-0">{customer.name}</h2>
                <Badge color={statusColors[customer.status]} rounded="full">
                  {t(`customers.status.${customer.status}`)}
                </Badge>
              </div>
              {customer.description && (
                <div className="mb-3 max-h-12 overflow-hidden text-gray-400">
                  <Markdown>{customer.description}</Markdown>
                </div>
              )}
              {customer.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {customer.tags.map((tag) => (
                    <Badge key={tag} color="bg-gray-800 text-gray-300">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              {(() => {
                const stats = statsByCustomer[customer._id];
                if (!stats) return null;
                return (
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Badge
                      color={
                        stats.openTodoCount > 0
                          ? 'bg-amber-900/40 text-amber-300 border border-amber-800/50'
                          : 'bg-gray-800 text-gray-500'
                      }
                    >
                      {t('customers.dashboard.openTodos', { count: stats.openTodoCount })}
                    </Badge>
                    <Badge
                      color={
                        stats.projectCount > 0
                          ? 'bg-violet-900/40 text-violet-300 border border-violet-800/50'
                          : 'bg-rose-900/40 text-rose-300 border border-rose-800/50'
                      }
                    >
                      {t('customers.dashboard.projects', { count: stats.projectCount })}
                    </Badge>
                  </div>
                );
              })()}
              <p className="text-xs text-gray-600 mt-3">
                {t('common.created')}: {new Date(customer.createdAt).toLocaleDateString(dateLocale)}
                {' · '}
                {t('common.updated')}: {new Date(customer.updatedAt).toLocaleDateString(dateLocale)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: number;
  tone: 'default' | 'amber' | 'rose';
}

function KpiTile({ label, value, tone }: KpiTileProps) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-800/40 bg-amber-950/20'
      : tone === 'rose'
        ? 'border-rose-800/40 bg-rose-950/20'
        : 'border-gray-800 bg-gray-900';
  const valueColor =
    tone === 'amber' ? 'text-amber-300' : tone === 'rose' ? 'text-rose-300' : 'text-gray-100';
  return (
    <div className={`border rounded-lg p-3 ${toneClass}`}>
      <div className={`text-2xl font-semibold ${valueColor}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{label}</div>
    </div>
  );
}
