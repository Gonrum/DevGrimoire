import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, CheckSquare, Flag, History, Activity,
  BookOpen, ScrollText, BookMarked, FileHeart, FlaskConical, Scissors, Paperclip,
  Zap, Share2, Sparkles, Database, Package, Tag,
  Ghost, FolderGit2, Settings2, KeyRound, Globe, TerminalSquare, Repeat, Workflow,
  GitCommit, FileText, Users, Container,
} from 'lucide-react';

export type Tab =
  | 'overview' | 'todos' | 'soul' | 'milestones' | 'sessions' | 'knowledge' | 'changelog'
  | 'activity' | 'environments' | 'secrets' | 'manual' | 'research' | 'schemas' | 'dependencies'
  | 'features' | 'commits' | 'recurring-tasks' | 'snippets' | 'files' | 'logs' | 'releases'
  | 'workspaces' | 'workflows' | 'ssh' | 'kube' | 'http-requests' | 'docs-health' | 'graph' | 'oracle' | 'access';

export interface NavItem {
  key: Tab;
  label: string;
  count?: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const TAB_ICON: Record<Tab, LucideIcon> = {
  overview: LayoutDashboard,
  todos: CheckSquare,
  milestones: Flag,
  sessions: History,
  activity: Activity,
  knowledge: BookOpen,
  changelog: ScrollText,
  manual: BookMarked,
  'docs-health': FileHeart,
  research: FlaskConical,
  snippets: Scissors,
  files: Paperclip,
  features: Zap,
  graph: Share2,
  oracle: Sparkles,
  schemas: Database,
  dependencies: Package,
  releases: Tag,
  soul: Ghost,
  workspaces: FolderGit2,
  environments: Settings2,
  secrets: KeyRound,
  'http-requests': Globe,
  ssh: TerminalSquare,
  kube: Container,
  'recurring-tasks': Repeat,
  workflows: Workflow,
  commits: GitCommit,
  logs: FileText,
  access: Users,
};
