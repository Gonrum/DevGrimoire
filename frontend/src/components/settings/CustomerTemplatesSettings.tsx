import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  Customer,
  CustomerTemplate,
  CustomerTemplateApplyResult,
  CustomerTemplateItem,
  CustomerTemplateItemKind,
  CustomerTemplatePreview,
  CustomerTemplateType,
} from '../../api/client';
import { isRecord, isUnknownArray, matchOption, optionOr } from '../../lib/narrow';
import Button from '../ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../ui/FormField';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

const TYPES: CustomerTemplateType[] = [
  'onboarding',
  'todo_list',
  'monitoring',
  'environment',
  'workflow',
  'contact_type',
];

const ITEM_KINDS: CustomerTemplateItemKind[] = [
  'todo',
  'monitoring_check',
  'environment',
  'workflow',
  'contact_type',
  'note',
];

interface DraftTemplate {
  _id?: string;
  name: string;
  slug: string;
  description: string;
  type: CustomerTemplateType;
  tags: string;
  active: boolean;
  itemsJson: string;
}

const EMPTY_DRAFT: DraftTemplate = {
  name: '',
  slug: '',
  description: '',
  type: 'onboarding',
  tags: '',
  active: true,
  itemsJson: '[]',
};

function templateToDraft(t: CustomerTemplate): DraftTemplate {
  return {
    _id: t._id,
    name: t.name,
    slug: t.slug,
    description: t.description ?? '',
    type: t.type,
    tags: t.tags.join(', '),
    active: t.active,
    itemsJson: JSON.stringify(t.items, null, 2),
  };
}

function toStringArray(value: unknown, where: string): string[] {
  if (!isUnknownArray(value)) throw new Error(`${where} must be an array`);
  return value.map((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`${where}[${i}] must be a string`);
    return entry;
  });
}

function toStringRecord(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${where}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

/**
 * Ein Item aus dem freien JSON-Textfeld.
 *
 * Vorher stand hier ein blosses `Array.isArray` plus impliziter `any`-Durchlauf:
 * jedes `{}` galt als gültiges Item, und der Nutzer erfuhr erst über einen
 * 400er des Backends, dass etwas fehlte — ohne zu wissen, welches Item.
 * `payload` fehlt darf, das Backend setzt dort selbst `?? {}`.
 */
function toTemplateItem(value: unknown, where: string): CustomerTemplateItem {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const kind = typeof value.kind === 'string' ? matchOption(value.kind, ITEM_KINDS) : undefined;
  if (!kind) throw new Error(`${where}.kind must be one of: ${ITEM_KINDS.join(', ')}`);
  if (typeof value.title !== 'string') throw new Error(`${where}.title must be a string`);
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error(`${where}.description must be a string`);
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    throw new Error(`${where}.payload must be an object`);
  }
  return {
    kind,
    title: value.title,
    ...(value.description !== undefined ? { description: value.description } : {}),
    payload: value.payload ?? {},
    ...(value.requiredSecretKeys !== undefined
      ? { requiredSecretKeys: toStringArray(value.requiredSecretKeys, `${where}.requiredSecretKeys`) }
      : {}),
    ...(value.placeholders !== undefined
      ? { placeholders: toStringRecord(value.placeholders, `${where}.placeholders`) }
      : {}),
  };
}

function parseDraftItems(json: string): CustomerTemplateItem[] {
  const parsed: unknown = JSON.parse(json || '[]');
  if (!isUnknownArray(parsed)) throw new Error('items must be a JSON array');
  return parsed.map((entry, i) => toTemplateItem(entry, `items[${i}]`));
}

export default function CustomerTemplatesSettings() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<CustomerTemplate[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [draft, setDraft] = useState<DraftTemplate | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);

  const [applyTarget, setApplyTarget] = useState<CustomerTemplate | null>(null);
  const [applyCustomerId, setApplyCustomerId] = useState<string>('');
  const [preview, setPreview] = useState<CustomerTemplatePreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<CustomerTemplateApplyResult | null>(null);

  // Der Fetch gehört dem Effect; Schreibpfade stossen ihn über den Token an,
  // statt eine State-setzende Funktion synchron aus dem Effect zu rufen.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [list, custs] = await Promise.all([
          api.customerTemplates.list(),
          api.customers.list({ includeArchived: false }),
        ]);
        if (cancelled) return;
        setTemplates(list);
        setCustomers(custs);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);

  const startNew = () => {
    setDraft({ ...EMPTY_DRAFT });
    setSuccess(null);
    setError(null);
  };

  const startEdit = (tpl: CustomerTemplate) => {
    setDraft(templateToDraft(tpl));
    setSuccess(null);
    setError(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSavingDraft(true);
    setError(null);
    try {
      const items = parseDraftItems(draft.itemsJson);
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        description: draft.description.trim() || undefined,
        type: draft.type,
        active: draft.active,
        tags: draft.tags
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        items,
      };
      if (draft._id) {
        await api.customerTemplates.update(draft._id, payload);
      } else {
        await api.customerTemplates.create(payload);
      }
      setDraft(null);
      setSuccess(t('customerTemplates.saved'));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSavingDraft(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(t('customerTemplates.confirmDelete'))) return;
    setError(null);
    try {
      await api.customerTemplates.remove(id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
    }
  };

  const openApply = (tpl: CustomerTemplate) => {
    setApplyTarget(tpl);
    setApplyCustomerId('');
    setPreview(null);
    setApplyResult(null);
  };

  const loadPreview = async () => {
    if (!applyTarget || !applyCustomerId) return;
    setError(null);
    try {
      const p = await api.customerTemplates.preview(applyTarget._id, applyCustomerId);
      setPreview(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview failed');
    }
  };

  const doApply = async () => {
    if (!applyTarget || !applyCustomerId) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.customerTemplates.apply(applyTarget._id, applyCustomerId);
      setApplyResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'apply failed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <SettingsTabHeader description={t('customerTemplates.tabDescription')} />

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/50 border border-green-700 text-green-300 px-4 py-2 rounded mb-4">
          {success}
        </div>
      )}

      <SettingsSection title={t('customerTemplates.listTitle')}>
        <div className="flex justify-between items-center mb-3">
          <p className="text-sm text-gray-400">
            {loading ? t('common.loading') : t('customerTemplates.count', { count: templates.length })}
          </p>
          <Button variant="primary" onClick={startNew}>
            {t('customerTemplates.newTemplate')}
          </Button>
        </div>

        <div className="grid gap-3">
          {templates.map((tpl) => (
            <div
              key={tpl._id}
              className="border border-gray-700 rounded p-4 bg-gray-900/40"
            >
              <div className="flex justify-between items-start gap-4">
                <div>
                  <div className="font-medium text-gray-100">
                    {tpl.name}{' '}
                    <span className="text-xs text-gray-500">v{tpl.version}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    <span className="font-mono">{tpl.slug}</span> · {tpl.type} ·{' '}
                    {t('customerTemplates.itemsCount', { count: tpl.items.length })}
                    {!tpl.active && ' · paused'}
                  </div>
                  {tpl.description && (
                    <p className="text-sm text-gray-300 mt-2">{tpl.description}</p>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button variant="secondary" onClick={() => openApply(tpl)} disabled={!tpl.active}>
                    {t('customerTemplates.apply')}
                  </Button>
                  <Button variant="secondary" onClick={() => startEdit(tpl)}>
                    {t('common.edit')}
                  </Button>
                  <Button variant="danger" onClick={() => { void remove(tpl._id); }}>
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {!loading && templates.length === 0 && (
            <p className="text-sm text-gray-500 italic">{t('customerTemplates.empty')}</p>
          )}
        </div>
      </SettingsSection>

      {draft && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-semibold text-gray-100 mb-4">
              {draft._id ? t('customerTemplates.editTitle') : t('customerTemplates.newTitle')}
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormInput
                  label={t('common.name')}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <FormInput
                  label="slug"
                  value={draft.slug}
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                />
              </div>
              <FormSelect
                label={t('customerTemplates.type')}
                value={draft.type}
                onChange={(e) =>
                  setDraft({ ...draft, type: optionOr(e.target.value, TYPES, draft.type) })
                }
              >
                {TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </FormSelect>
              <FormInput
                label={t('common.description')}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <FormInput
                label={t('customerTemplates.tagsCsv')}
                value={draft.tags}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              />
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                />
                {t('customerTemplates.active')}
              </label>
              <FormTextarea
                label={t('customerTemplates.itemsJson')}
                value={draft.itemsJson}
                onChange={(e) => setDraft({ ...draft, itemsJson: e.target.value })}
                rows={14}
                className="font-mono text-xs"
              />
              <p className="text-xs text-gray-500">
                {t('customerTemplates.itemsJsonHint')}
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={savingDraft}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => { void saveDraft(); }} disabled={savingDraft}>
                {savingDraft ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {applyTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-semibold text-gray-100 mb-1">
              {t('customerTemplates.applyTitle', { name: applyTarget.name })}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              v{applyTarget.version} · {applyTarget.items.length} items
            </p>

            {!applyResult && (
              <>
                <FormSelect
                  label={t('customerTemplates.targetCustomer')}
                  value={applyCustomerId}
                  onChange={(e) => {
                    setApplyCustomerId(e.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">—</option>
                  {customers.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </FormSelect>

                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" onClick={() => { void loadPreview(); }} disabled={!applyCustomerId}>
                    {t('customerTemplates.loadPreview')}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => { void doApply(); }}
                    disabled={!applyCustomerId || applying}
                  >
                    {applying ? t('common.saving') : t('customerTemplates.applyNow')}
                  </Button>
                </div>

                {preview && (
                  <div className="mt-4 border-t border-gray-700 pt-3">
                    <h4 className="text-sm font-medium text-gray-200 mb-2">
                      {t('customerTemplates.previewTitle')}
                    </h4>
                    <ul className="text-sm space-y-1">
                      {preview.items.map((it, i) => (
                        <li key={i} className="text-gray-300">
                          <span className="inline-block w-32 text-xs text-gray-500 font-mono">
                            {it.kind}
                          </span>
                          {it.title}
                        </li>
                      ))}
                    </ul>
                    {preview.requiredSecretKeys.length > 0 && (
                      <p className="mt-3 text-xs text-amber-400">
                        {t('customerTemplates.requiredSecretKeys')}:{' '}
                        <span className="font-mono">
                          {preview.requiredSecretKeys.join(', ')}
                        </span>
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            {applyResult && (
              <div className="space-y-2 text-sm">
                <p className="text-green-400">
                  {t('customerTemplates.appliedSummary', {
                    count: applyResult.created.length,
                  })}
                </p>
                <ul className="space-y-1 max-h-64 overflow-y-auto">
                  {applyResult.created.map((c, i) => (
                    <li key={i} className="text-gray-300">
                      <span className="inline-block w-32 text-xs text-gray-500 font-mono">
                        {c.kind}
                      </span>
                      {c.title}
                      {c.note && (
                        <span className="ml-2 text-xs text-amber-400">[{c.note}]</span>
                      )}
                    </li>
                  ))}
                </ul>
                {applyResult.missingSecretKeys.length > 0 && (
                  <p className="text-xs text-amber-400">
                    {t('customerTemplates.requiredSecretKeys')}:{' '}
                    <span className="font-mono">
                      {applyResult.missingSecretKeys.join(', ')}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <Button
                variant="secondary"
                onClick={() => {
                  setApplyTarget(null);
                  setApplyResult(null);
                  setPreview(null);
                }}
              >
                {applyResult ? t('common.close') : t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
