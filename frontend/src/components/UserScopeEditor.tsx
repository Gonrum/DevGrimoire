import { useEffect, useState } from 'react';
import { api, UserInfo, ScopeMode } from '../api/client';
import { useTranslation } from 'react-i18next';
import { useToast } from './Toast';
import Button from './ui/Button';
import Card from './ui/Card';

interface ProjectOption { _id: string; name: string }
interface CustomerOption { _id: string; name: string }

interface Props {
  user: UserInfo;
  onSave: (payload: {
    projectScopeMode?: ScopeMode;
    allowedProjectIds?: string[];
    customerScopeMode?: ScopeMode;
    allowedCustomerIds?: string[];
  }) => Promise<void>;
  onClose: () => void;
}

const SCOPE_MODES: ScopeMode[] = ['all', 'allowlist', 'none'];

/**
 * Mirror of ApiKeyScopeEditor for human users. Lets an admin restrict a user's
 * project + customer reach. The two axes are independent — same semantics as
 * api-key scope. Backend enforces via JwtAuthGuard scope-enrichment.
 */
export default function UserScopeEditor({ user, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();

  const [projectMode, setProjectMode] = useState<ScopeMode>(user.projectScopeMode ?? 'all');
  const [customerMode, setCustomerMode] = useState<ScopeMode>(user.customerScopeMode ?? 'all');
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set(user.allowedProjectIds ?? []));
  const [customerIds, setCustomerIds] = useState<Set<string>>(new Set(user.allowedCustomerIds ?? []));

  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.projects.list(),
      api.customers.list({ includeArchived: true }),
    ])
      .then(([projs, custs]) => {
        if (cancelled) return;
        setProjects(projs.map((p: any) => ({ _id: p._id, name: p.name })));
        setCustomers(custs.map((c: any) => ({ _id: c._id, name: c.name })));
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const handleSave = async () => {
    if (projectMode === 'allowlist' && projectIds.size === 0) {
      showError(t('userScope.projectAllowlistEmpty'));
      return;
    }
    if (customerMode === 'allowlist' && customerIds.size === 0) {
      showError(t('userScope.customerAllowlistEmpty'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        projectScopeMode: projectMode,
        allowedProjectIds: Array.from(projectIds),
        customerScopeMode: customerMode,
        allowedCustomerIds: Array.from(customerIds),
      });
      showSuccess(t('common.saveSuccess'));
      onClose();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const renderAxis = (
    titleKey: string,
    descKey: string,
    mode: ScopeMode,
    setMode: (m: ScopeMode) => void,
    items: { _id: string; name: string }[] | null,
    selected: Set<string>,
    setter: (s: Set<string>) => void,
  ) => (
    <div className="border border-gray-800 rounded p-3 space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-gray-200">{t(titleKey)}</h4>
        <p className="text-xs text-gray-500 mt-0.5">{t(descKey)}</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {SCOPE_MODES.map((m) => (
          <label
            key={m}
            className={
              'flex items-center gap-2 cursor-pointer px-3 py-2 rounded text-xs border transition-colors ' +
              (mode === m
                ? 'bg-violet-900/40 border-violet-600 text-violet-100'
                : 'bg-gray-900/40 border-gray-700 text-gray-400 hover:border-violet-700')
            }
          >
            <input
              type="radio"
              checked={mode === m}
              onChange={() => setMode(m)}
              className="accent-violet-600"
            />
            {t(`userScope.mode_${m}`)}
          </label>
        ))}
      </div>
      {mode === 'allowlist' && (
        items === null ? (
          <div className="text-xs text-gray-500">{t('common.loading')}</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-gray-500">{t('userScope.noItems')}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-56 overflow-y-auto pr-1">
            {items.map((item) => (
              <label key={item._id} className="flex items-center gap-2 text-xs text-gray-300 px-2 py-1.5 rounded hover:bg-gray-800/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(item._id)}
                  onChange={() => toggle(selected, setter, item._id)}
                  className="accent-violet-600"
                />
                <span className="truncate">{item.name}</span>
              </label>
            ))}
          </div>
        )
      )}
      {mode === 'none' && (
        <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded px-3 py-2">
          {t('userScope.modeNoneWarning')}
        </div>
      )}
    </div>
  );

  return (
    <Card padding="md" className="mt-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">
            {t('userScope.title')} — {user.username}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">{t('userScope.description')}</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300">
          {t('common.close')}
        </button>
      </div>

      {user.role === 'admin' && (
        <div className="bg-amber-950/20 border border-amber-800/40 rounded px-3 py-2 mb-3 text-xs text-amber-200">
          {t('userScope.adminWarning')}
        </div>
      )}

      {loadError && (
        <div className="bg-red-900/40 border border-red-700 text-red-300 rounded px-3 py-2 mb-3 text-xs">
          {loadError}
        </div>
      )}

      <div className="space-y-3">
        {renderAxis('userScope.projectsTitle', 'userScope.projectsDesc', projectMode, setProjectMode, projects, projectIds, setProjectIds)}
        {renderAxis('userScope.customersTitle', 'userScope.customersDesc', customerMode, setCustomerMode, customers, customerIds, setCustomerIds)}
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-800">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </Card>
  );
}
