import { useState } from 'react';
import { Search } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowScope } from '../../api/workflows';
import { nodeCategoryStyles, nodeCategoryLabels, NodeCategory } from './nodeCategoryStyles';
import { getNodeIcon } from './nodeTypeIconMap';

interface Props {
  catalog: WorkflowNodeMetadata[];
  workflowScope: WorkflowScope;
  onDragStart: (e: React.DragEvent, type: string) => void;
  onTapPlace: (type: string) => void;
  touchMode: boolean;
}

const CATEGORIES: NodeCategory[] = ['trigger', 'action', 'control', 'agent'];

export function WorkflowNodePalette({ catalog, workflowScope, onDragStart, onTapPlace, touchMode }: Props) {
  const [search, setSearch] = useState('');
  const [openCats, setOpenCats] = useState<Record<NodeCategory, boolean>>({
    trigger: true, action: true, control: true, agent: true,
  });

  const q = search.trim().toLowerCase();
  const matches = (m: WorkflowNodeMetadata) =>
    !q || m.label.toLowerCase().includes(q) || m.type.toLowerCase().includes(q);

  return (
    <div className="flex h-full flex-col border-r border-gray-800 bg-gray-950">
      <div className="border-b border-gray-800 p-2">
        <div className="flex items-center gap-2 rounded border border-gray-700 bg-gray-900 px-2 py-1">
          <Search size={14} className="text-gray-500" />
          <input
            type="text"
            placeholder="Suche…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm text-gray-200 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {CATEGORIES.map((cat) => {
          const items = catalog.filter((m) => m.category === cat && matches(m));
          if (items.length === 0) return null;
          const style = nodeCategoryStyles[cat];
          const isOpen = openCats[cat];
          return (
            <div key={cat} className="mb-2">
              <button
                type="button"
                onClick={() => setOpenCats((s) => ({ ...s, [cat]: !s[cat] }))}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-xs uppercase tracking-wide text-gray-400 hover:bg-gray-900"
              >
                <span className={style.pillText}>{nodeCategoryLabels[cat]}</span>
                <span className="text-gray-600">({items.length})</span>
              </button>
              {isOpen && (
                <ul className="mt-1 space-y-1">
                  {items.map((m) => {
                    const allowed = m.allowedScopes.includes(workflowScope);
                    const Icon = getNodeIcon(m.type);
                    return (
                      <li
                        key={m.type}
                        draggable={!touchMode && allowed}
                        onDragStart={(e) => allowed && onDragStart(e, m.type)}
                        onClick={() => touchMode && allowed && onTapPlace(m.type)}
                        title={allowed ? m.description : `Nicht erlaubt für scope=${workflowScope}`}
                        className={`flex items-center gap-2 rounded border ${allowed ? `${style.border} cursor-pointer hover:bg-gray-900` : 'border-gray-800 opacity-40 cursor-not-allowed'} bg-gray-900/40 px-2 py-2`}
                      >
                        <Icon size={14} className="text-gray-300" />
                        <span className="text-sm text-gray-200">{m.label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
