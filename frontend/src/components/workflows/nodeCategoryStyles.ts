export type NodeCategory = 'trigger' | 'action' | 'control' | 'agent';

interface CategoryStyle {
  border: string;
  headerBg: string;
  dotBg: string;
  pillBg: string;
  pillText: string;
}

export const nodeCategoryStyles: Record<NodeCategory, CategoryStyle> = {
  trigger: {
    border: 'border-cyan-600',
    headerBg: 'bg-cyan-900/40',
    dotBg: 'bg-cyan-400',
    pillBg: 'bg-cyan-900/50',
    pillText: 'text-cyan-300',
  },
  action: {
    border: 'border-violet-600',
    headerBg: 'bg-violet-900/40',
    dotBg: 'bg-violet-400',
    pillBg: 'bg-violet-900/50',
    pillText: 'text-violet-300',
  },
  control: {
    border: 'border-amber-600',
    headerBg: 'bg-amber-900/40',
    dotBg: 'bg-amber-400',
    pillBg: 'bg-amber-900/50',
    pillText: 'text-amber-300',
  },
  agent: {
    border: 'border-pink-600',
    headerBg: 'bg-pink-900/40',
    dotBg: 'bg-pink-400',
    pillBg: 'bg-pink-900/50',
    pillText: 'text-pink-300',
  },
};

export const nodeCategoryLabels: Record<NodeCategory, string> = {
  trigger: 'Trigger',
  action: 'Action',
  control: 'Control',
  agent: 'Agent',
};
