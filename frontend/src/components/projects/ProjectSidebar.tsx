import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { NavGroup, Tab, TAB_ICON } from './tabs';
import { parseJsonText } from '../../api/http-boundary';
import { isRecord } from '../../lib/narrow';

const LS_COLLAPSED = 'dg.projectSidebar.collapsed';
const LS_GROUPS = 'dg.projectSidebar.groups';

function readBool(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
/*
 * `localStorage` ist fremder Speicher: der Inhalt kann von einer älteren
 * Version stammen oder von Hand verändert sein. Vorher stand hier
 * `JSON.parse(...)` direkt im Return — dessen `any` floss ungeprüft in
 * `Record<string, boolean>` und von dort in `groupState`. Ein `{"foo": "bar"}`
 * im Storage hätte einen String als Boolean in den State gelegt.
 */
function readGroups(): Record<string, boolean> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_GROUPS);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonText<unknown>(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

interface Props {
  groups: NavGroup[];
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  variant?: 'desktop' | 'drawer';
}

export default function ProjectSidebar({ groups, activeTab, onSelect, variant = 'desktop' }: Props) {
  const { t } = useTranslation();
  // Drawer (mobile) ist immer voll ausgeklappt; Minimieren nur auf dem Desktop.
  const [collapsed, setCollapsed] = useState(() => variant === 'desktop' && readBool(LS_COLLAPSED));
  const [groupState, setGroupState] = useState<Record<string, boolean>>(readGroups);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (variant !== 'desktop') return;
    try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed, variant]);

  useEffect(() => {
    try { localStorage.setItem(LS_GROUPS, JSON.stringify(groupState)); } catch { /* ignore */ }
  }, [groupState]);

  const q = search.trim().toLowerCase();
  const searching = q.length > 0 && !collapsed;

  const toggleGroup = (label: string) =>
    setGroupState((s) => ({ ...s, [label]: !s[label] }));

  return (
    <nav className={`${collapsed ? 'w-14' : 'w-56'} shrink-0 transition-[width] duration-150`}>
      {variant === 'desktop' && (
        <div className={`flex ${collapsed ? 'justify-center' : 'justify-between'} items-center mb-3 px-1`}>
          {!collapsed && (
            <div className="relative flex-1 mr-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('sidebar.search')}
                className="w-full bg-gray-800/60 text-sm text-gray-200 placeholder-gray-600 rounded-lg pl-7 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            className="text-gray-500 hover:text-gray-300 p-1 shrink-0"
          >
            {collapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>
        </div>
      )}

      <div className="space-y-4">
        {groups.map((group, gi) => {
          const items = searching
            ? group.items.filter((it) => it.label.toLowerCase().includes(q))
            : group.items;
          if (items.length === 0) return null;
          const groupCollapsed = !searching && !collapsed && groupState[group.label];

          return (
            <div key={group.label}>
              {collapsed ? (
                gi > 0 && <div className="border-t border-gray-800 my-2" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  className="w-full flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 hover:text-gray-400 px-3 mb-1.5"
                >
                  {searching ? null : groupCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  <span>{group.label}</span>
                </button>
              )}

              {!groupCollapsed && (
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = TAB_ICON[item.key];
                    const active = activeTab === item.key;
                    const showBadge = typeof item.count === 'number';
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          onClick={() => onSelect(item.key)}
                          title={collapsed ? item.label : undefined}
                          className={`w-full text-left rounded-lg flex items-center transition-colors ${
                            collapsed ? 'justify-center px-0 py-2 relative' : 'justify-between px-3 py-1.5'
                          } text-sm ${
                            active ? 'bg-gray-800 text-cyan-400 font-medium' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                          }`}
                        >
                          {collapsed ? (
                            <>
                              <Icon className="w-5 h-5" />
                              {showBadge && item.count! > 0 && (
                                <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-cyan-500" />
                              )}
                            </>
                          ) : (
                            <>
                              <span className="flex items-center gap-2 min-w-0">
                                <Icon className="w-4 h-4 shrink-0" />
                                <span className="truncate">{item.label}</span>
                              </span>
                              {showBadge && (
                                <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ml-2 ${
                                  active ? 'bg-gray-700 text-cyan-400' : 'bg-gray-800/80 text-gray-500'
                                }`}>
                                  {item.count}
                                </span>
                              )}
                            </>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
