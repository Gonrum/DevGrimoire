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
  isWrite: boolean;
}

type Mode = 'all' | 'scoped';

interface ToolPreset {
  id: string;
  labelKey: string;
  descKey: string;
  tools: string[];
}

// Curated tool sets surfaced as one-click presets in the editor. Selecting a
// preset switches the editor into 'scoped' mode and replaces the current
// allow-list — the user can then fine-tune individual tools afterwards.
const TOOL_PRESETS: ToolPreset[] = [
  {
    id: 'code-analyst',
    labelKey: 'settings.apiKeyToolPresetCodeAnalyst',
    descKey: 'settings.apiKeyToolPresetCodeAnalystDesc',
    tools: [
      // Workspace CRUD
      'workspace_create', 'workspace_list', 'workspace_get',
      'workspace_update', 'workspace_delete', 'workspace_archive',
      // Workspace operations
      'workspace_clone', 'workspace_pull', 'workspace_tree',
      'workspace_read', 'workspace_search', 'workspace_status',
      'workspace_exec',
      // DevGrimoire persistence the agent should use to record findings
      'todo_create', 'todo_list', 'milestone_list',
      'knowledge_save', 'snippet_save',
    ],
  },
  {
    id: 'bonsai-minimal',
    labelKey: 'settings.apiKeyToolPresetBonsai',
    descKey: 'settings.apiKeyToolPresetBonsaiDesc',
    tools: [
      'project_get', 'todo_list', 'todo_get', 'todo_create',
      'todo_update', 'todo_comment',
      'rag_search', 'knowledge_save',
      'session_save', 'ask_user', 'notify_user',
    ],
  },
];

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

  const setAllInGroup = (group: string, isWrite: boolean, enabled: boolean) => {
    if (!catalog) return;
    const groupTools = catalog
      .filter((tool) => tool.group === group && tool.isWrite === isWrite)
      .map((tool) => tool.name);
    if (enabled && isWrite && groupTools.length > 0) {
      const msg = t('settings.apiKeyToolSelectAllWriteConfirm', { count: groupTools.length });
      if (!window.confirm(msg)) return;
    }
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
    if (enabled) {
      const writeCount = catalog.filter((tool) => tool.isWrite).length;
      if (writeCount > 0) {
        const msg = t('settings.apiKeyToolSelectAllWriteConfirm', { count: writeCount });
        if (!window.confirm(msg)) return;
      }
    }
    setSelected(enabled ? new Set(catalog.map((tool) => tool.name)) : new Set());
  };

  const applyPreset = (preset: ToolPreset) => {
    if (!catalog) return;
    // Drop preset entries that don't exist in the live catalog so an outdated
    // preset never silently grants nothing — quietly ignore unknowns.
    const known = new Set(catalog.map((tool) => tool.name));
    const next = new Set(preset.tools.filter((name) => known.has(name)));
    setMode('scoped');
    setSelected(next);
  };

  // Match a preset by exact tool-set membership so the active preset can be
  // highlighted even after the user toggles individual tools (resets pill
  // highlight when divergent).
  const activePresetId = useMemo(() => {
    if (mode !== 'scoped') return null;
    for (const preset of TOOL_PRESETS) {
      if (preset.tools.length !== selected.size) continue;
      let match = true;
      for (const name of preset.tools) {
        if (!selected.has(name)) { match = false; break; }
      }
      if (match) return preset.id;
    }
    return null;
  }, [mode, selected]);

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

  const activeWriteCount = useMemo(() => {
    if (!catalog) return 0;
    const writeTools = new Set(catalog.filter((tool) => tool.isWrite).map((tool) => tool.name));
    let count = 0;
    selected.forEach((n) => { if (writeTools.has(n)) count += 1; });
    return count;
  }, [catalog, selected]);

  const totalWriteCount = useMemo(() => (
    catalog?.filter((tool) => tool.isWrite).length ?? 0
  ), [catalog]);

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

      {mode === 'all' && totalWriteCount > 0 && (
        <div className="bg-red-900/20 border border-red-800/50 rounded px-3 py-2 mb-4 text-xs text-red-200">
          ⚠ {t('settings.apiKeyToolAllWriteWarning', { count: totalWriteCount })}
        </div>
      )}

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
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
                  {t('settings.apiKeyToolPresets')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {TOOL_PRESETS.map((preset) => {
                    const active = activePresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        title={t(preset.descKey)}
                        className={
                          'text-xs px-3 py-1.5 rounded border transition-colors ' +
                          (active
                            ? 'bg-violet-700 border-violet-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-violet-600 hover:text-violet-300')
                        }
                      >
                        {t(preset.labelKey)}
                        <span className="ml-2 text-[10px] opacity-70">({preset.tools.length})</span>
                      </button>
                    );
                  })}
                </div>
              </div>

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

              {activeWriteCount > 0 && (
                <div className="bg-red-900/20 border border-red-800/50 rounded px-3 py-2 mb-3 text-xs text-red-200">
                  ⚠ {t('settings.apiKeyToolWriteBanner', { count: activeWriteCount })}
                </div>
              )}

              <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
                {groups.map((group) => {
                  const groupTools = filteredCatalog.filter((tool) => tool.group === group);
                  if (groupTools.length === 0) return null;
                  const groupTotal = catalog.filter((tool) => tool.group === group).length;
                  const groupSelected = catalog.filter(
                    (tool) => tool.group === group && selected.has(tool.name),
                  ).length;

                  const renderSubsection = (isWrite: boolean) => {
                    const subTools = groupTools.filter((tool) => tool.isWrite === isWrite);
                    if (subTools.length === 0) return null;
                    const subTotal = catalog.filter((tool) => tool.group === group && tool.isWrite === isWrite).length;
                    const subSelected = catalog.filter(
                      (tool) => tool.group === group && tool.isWrite === isWrite && selected.has(tool.name),
                    ).length;
                    const allSelected = subSelected === subTotal;
                    const boxCls = isWrite
                      ? 'bg-red-950/20 border-red-900/50'
                      : 'bg-gray-800/40 border-gray-800';
                    return (
                      <div key={`${group}-${isWrite ? 'write' : 'read'}`} className={`border rounded p-2.5 ${boxCls}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-[11px] font-medium text-gray-300 flex items-center gap-2">
                            {isWrite ? t('settings.apiKeyToolWriteSection') : t('settings.apiKeyToolReadSection')}
                            {isWrite && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-900/60 text-red-200 border border-red-800 uppercase tracking-wide">
                                {t('settings.apiKeyToolWriteBadge')}
                              </span>
                            )}
                            <span className="text-gray-600 ml-1">{subSelected}/{subTotal}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAllInGroup(group, isWrite, !allSelected)}
                            className={`text-[10px] uppercase font-bold ${isWrite ? 'text-red-300 hover:text-red-200' : 'text-cyan-400 hover:text-cyan-300'}`}
                          >
                            {allSelected ? t('common.deselectAll') : t('common.selectAll')}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                          {subTools.map((tool) => (
                            <label
                              key={tool.name}
                              title={tool.description}
                              className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                                isWrite
                                  ? 'border-red-900/40 bg-red-950/10 hover:bg-red-950/30'
                                  : 'border-gray-800 bg-gray-800/50 hover:bg-gray-800'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected.has(tool.name)}
                                onChange={() => toggleTool(tool.name)}
                                className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${isWrite ? 'accent-red-600' : 'accent-violet-600'}`}
                              />
                              <span className={`text-xs font-mono truncate ${isWrite ? 'text-red-200/90' : 'text-gray-300'}`}>
                                {tool.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  };

                  return (
                    <div key={group} className="space-y-2">
                      <div className="flex items-center justify-between px-1 sticky top-0 bg-gray-900 py-1 z-10">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                          {group}{' '}
                          <span className="text-gray-600 normal-case ml-1">
                            {groupSelected}/{groupTotal}
                          </span>
                        </span>
                      </div>
                      {renderSubsection(false)}
                      {renderSubsection(true)}
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
