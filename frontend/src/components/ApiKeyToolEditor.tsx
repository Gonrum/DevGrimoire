import { useState, useEffect, useMemo } from 'react';
import { api, ApiKeyInfo } from '../api/client';
import { useTranslation } from 'react-i18next';
import { useToast } from './Toast';
import Button from './ui/Button';
import Card from './ui/Card';

interface ToolOption {
  name: string;
  description: string;
  group: string;
}

type Mode = 'all' | 'scoped';

interface Props {
  apiKey: ApiKeyInfo;
  onSave: (allowedTools: string[] | null) => Promise<void>;
  onClose: () => void;
}

export default function ApiKeyToolEditor({ apiKey, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();

  const initialMode: Mode = Array.isArray(apiKey.allowedTools) ? 'scoped' : 'all';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(apiKey.allowedTools ?? []),
  );
  const [catalog, setCatalog] = useState<ToolOption[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.mcp
      .tools()
      .then((list) => {
        if (!cancelled) setCatalog(list);
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    if (!catalog) return [] as string[];
    return Array.from(new Set(catalog.map((tool) => tool.group)));
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q),
    );
  }, [catalog, search]);

  const toggleTool = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const setAllInGroup = (group: string, enabled: boolean) => {
    if (!catalog) return;
    const groupTools = catalog.filter((tool) => tool.group === group).map((tool) => tool.name);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const n of groupTools) {
        if (enabled) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  };

  const setAll = (enabled: boolean) => {
    if (!catalog) return;
    setSelected(enabled ? new Set(catalog.map((tool) => tool.name)) : new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === 'all') {
        await onSave(null);
      } else {
        await onSave(Array.from(selected));
      }
      showSuccess(t('common.saveSuccess'));
      onClose();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const scopedEmpty = mode === 'scoped' && selected.size === 0;

  return (
    <Card padding="md" className="mt-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">
            {t('settings.apiKeyToolScoping')} — {apiKey.name}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {t('settings.apiKeyToolScopingDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          {t('common.close')}
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <label className="flex items-center gap-2 cursor-pointer bg-gray-800/50 border border-gray-700 rounded p-3 flex-1">
          <input
            type="radio"
            name="toolMode"
            checked={mode === 'all'}
            onChange={() => setMode('all')}
            className="accent-violet-600"
          />
          <div>
            <div className="text-sm text-gray-200">{t('settings.apiKeyToolModeAll')}</div>
            <div className="text-xs text-gray-500">{t('settings.apiKeyToolModeAllDesc')}</div>
          </div>
        </label>
        <label className="flex items-center gap-2 cursor-pointer bg-gray-800/50 border border-gray-700 rounded p-3 flex-1">
          <input
            type="radio"
            name="toolMode"
            checked={mode === 'scoped'}
            onChange={() => setMode('scoped')}
            className="accent-violet-600"
          />
          <div>
            <div className="text-sm text-gray-200">{t('settings.apiKeyToolModeScoped')}</div>
            <div className="text-xs text-gray-500">{t('settings.apiKeyToolModeScopedDesc')}</div>
          </div>
        </label>
      </div>

      {mode === 'scoped' && (
        <>
          {scopedEmpty && (
            <div className="bg-amber-900/30 border border-amber-700 text-amber-300 rounded px-3 py-2 mb-4 text-xs">
              {t('settings.apiKeyToolScopingEmptyWarning')}
            </div>
          )}

          {catalogError && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 rounded px-3 py-2 mb-4 text-xs">
              {catalogError}
            </div>
          )}

          {!catalog ? (
            <div className="text-gray-500 py-8 text-center text-sm">
              {t('common.loading')}
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row gap-2 mb-4">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('settings.apiKeyToolSearchPlaceholder')}
                  className="flex-1 bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
                <div className="flex gap-2">
                  <Button size="xs" variant="secondary" onClick={() => setAll(true)}>
                    {t('common.selectAll')}
                  </Button>
                  <Button size="xs" variant="secondary" onClick={() => setAll(false)}>
                    {t('common.deselectAll')}
                  </Button>
                </div>
              </div>

              <div className="text-xs text-gray-500 mb-3">
                {t('settings.apiKeyToolCountSelected', {
                  count: selected.size,
                  total: catalog.length,
                })}
              </div>

              <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
                {groups.map((group) => {
                  const groupTools = filteredCatalog.filter((tool) => tool.group === group);
                  if (groupTools.length === 0) return null;
                  const groupTotal = catalog.filter((tool) => tool.group === group).length;
                  const groupSelected = catalog.filter(
                    (tool) => tool.group === group && selected.has(tool.name),
                  ).length;
                  const allSelected = groupSelected === groupTotal;

                  return (
                    <div key={group} className="space-y-2">
                      <div className="flex items-center justify-between px-1 sticky top-0 bg-gray-900 py-1">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                          {group}{' '}
                          <span className="text-gray-600 normal-case ml-1">
                            {groupSelected}/{groupTotal}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setAllInGroup(group, !allSelected)}
                          className="text-[10px] text-cyan-400 hover:text-cyan-300 uppercase font-bold"
                        >
                          {allSelected ? t('common.deselectAll') : t('common.selectAll')}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                        {groupTools.map((tool) => (
                          <label
                            key={tool.name}
                            title={tool.description}
                            className="flex items-start gap-2 p-2 rounded border border-gray-800 bg-gray-800/50 hover:bg-gray-800 cursor-pointer transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(tool.name)}
                              onChange={() => toggleTool(tool.name)}
                              className="w-3.5 h-3.5 mt-0.5 accent-violet-600 flex-shrink-0"
                            />
                            <span className="text-xs text-gray-300 font-mono truncate">
                              {tool.name}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

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
