import {
  Activity, Bell, BookOpen, Circle, Clock, Edit, FileEdit, FileText,
  GitBranch, Hand, HelpCircle, History, Link, MessageSquare, Sparkles,
  SquarePlus, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const nodeTypeIconMap: Record<string, LucideIcon> = {
  'trigger.manual': Hand,
  'trigger.schedule': Clock,
  'trigger.project_event': Activity,
  'trigger.customer_event': Users,
  'action.log': FileText,
  'action.todo-create': SquarePlus,
  'action.todo-update': Edit,
  'action.todo-comment': MessageSquare,
  'action.todo-link-milestone': Link,
  'action.knowledge-create': BookOpen,
  'action.manual-create': FileEdit,
  'action.changelog-add': History,
  'action.notify': Bell,
  'action.user-question': HelpCircle,
  'control.condition': GitBranch,
  'control.delay': Clock,
  'agent.task': Sparkles,
};

export function getNodeIcon(type: string): LucideIcon {
  return nodeTypeIconMap[type] ?? Circle;
}
