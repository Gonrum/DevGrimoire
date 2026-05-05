import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Customer, CustomerProjectLink, Environment } from '../api/client';
import Badge from './ui/Badge';

const linkStatusColors: Record<CustomerProjectLink['status'], string> = {
  active: 'bg-green-900/40 text-green-300',
  paused: 'bg-yellow-900/30 text-yellow-300',
  archived: 'bg-gray-800 text-gray-500',
};

export default function ProjectCustomerLinks({
  projectId,
  environments,
}: {
  projectId: string;
  environments: Environment[];
}) {
  const { t } = useTranslation();
  const [links, setLinks] = useState<CustomerProjectLink[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.customers.listProjectCustomerLinks(projectId).catch(() => [] as CustomerProjectLink[]),
      api.customers.list({ projectId }).catch(() => [] as Customer[]),
    ])
      .then(([linkData, customerData]) => {
        if (cancelled) return;
        setLinks(linkData);
        setCustomers(customerData);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const customersById = useMemo(
    () => new Map(customers.map((c) => [c._id, c])),
    [customers],
  );
  const envsById = useMemo(
    () => new Map(environments.map((e) => [e._id, e])),
    [environments],
  );

  if (!loaded || links.length === 0) return null;

  return (
    <div className="mt-3 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          {t('customers.linkedCustomers')}
        </h3>
        <span className="text-xs text-gray-600">{links.length}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {links.map((link) => {
          const customer = customersById.get(link.customerId);
          const linkedEnvs = link.environmentIds
            .map((envId) => envsById.get(envId))
            .filter((env): env is Environment => Boolean(env));
          return (
            <div key={link._id} className="bg-gray-900 border border-gray-800 rounded p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {customer ? (
                    <Link
                      to={`/customers/${customer._id}`}
                      className="text-sm font-semibold text-gray-100 hover:text-cyan-300"
                    >
                      {customer.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-semibold text-gray-500">{link.customerId}</span>
                  )}
                  {link.role && <p className="text-xs text-cyan-400 mt-0.5">{link.role}</p>}
                </div>
                <Badge color={linkStatusColors[link.status]} rounded="full">
                  {link.status}
                </Badge>
              </div>
              {linkedEnvs.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {linkedEnvs.map((env) => (
                    <Badge key={env._id} color="bg-violet-900/30 text-violet-300">
                      {env.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
