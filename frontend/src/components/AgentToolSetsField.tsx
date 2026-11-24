import { useTranslation } from 'react-i18next';
import { WORKSPACE_AGENT_TOOL_SETS, type WorkspaceAgentToolSet } from '../api/client';

const LABEL_KEY: Record<WorkspaceAgentToolSet, string> = {
  todos: 'workspaces.agentToolSetTodos',
  knowledge: 'workspaces.agentToolSetKnowledge',
};

const TITLE_KEY: Record<WorkspaceAgentToolSet, string> = {
  todos: 'workspaces.agentToolSetTodosTools',
  knowledge: 'workspaces.agentToolSetKnowledgeTools',
};

/**
 * The IDE agent's optional tool sets as two checkboxes ("Todos", "Wissen").
 * Used in the workspace create form and in the agent sidebar.
 */
export function AgentToolSetsField({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: readonly WorkspaceAgentToolSet[];
  onChange: (next: WorkspaceAgentToolSet[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const toggle = (set: WorkspaceAgentToolSet, on: boolean): void => {
    onChange(WORKSPACE_AGENT_TOOL_SETS.filter((s) => (s === set ? on : value.includes(s))));
  };

  const label = t('workspaces.agentToolSets');
  const boxes = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label={label}>
      {WORKSPACE_AGENT_TOOL_SETS.map((set) => (
        <label key={set} className="inline-flex items-center gap-1.5 text-gray-300" title={t(TITLE_KEY[set])}>
          <input
            type="checkbox"
            className="accent-cyan-500"
            checked={value.includes(set)}
            disabled={disabled}
            onChange={(e) => toggle(set, e.target.checked)}
          />
          <span className={compact ? 'text-xs' : 'text-sm'}>{t(LABEL_KEY[set])}</span>
        </label>
      ))}
    </div>
  );

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-400" title={t('workspaces.agentToolSetsHint')}>{label}</span>
        {boxes}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <span className="block text-xs text-gray-500">{label}</span>
      {boxes}
      <p className="text-[11px] text-gray-500">{t('workspaces.agentToolSetsHint')}</p>
    </div>
  );
}
