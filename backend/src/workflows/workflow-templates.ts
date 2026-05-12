import { WorkflowScope } from './schemas/workflow-definition.schema';

/**
 * Workflow templates ship with DevGrimoire so users don't face an empty canvas.
 * Each entry describes a complete `WorkflowDefinition` skeleton with sensible
 * defaults — instantiation copies `nodes`/`edges`/`trigger` into a fresh
 * draft and leaves the user to tweak prompts/cron in the editor.
 *
 * Adding a new template:
 *  1. Append an entry below.
 *  2. List which scope it supports (PROJECT/CUSTOMER/SYSTEM).
 *  3. Use only MVP-allowed node types (see workflow-security.policy.ts).
 *  4. Keep prompts generic; the user will refine after instantiation.
 */

export interface WorkflowTemplateNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
  secretRefs?: string[];
}

export interface WorkflowTemplateEdge {
  id: string;
  source: string;
  target: string;
  branch?: 'success' | 'failure' | 'always' | 'custom';
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'triage' | 'review' | 'monitoring' | 'release' | 'research';
  supportedScopes: WorkflowScope[];
  /** Default cron / interval for the schedule trigger (user can override). */
  trigger: { type: 'manual' | 'schedule'; cron?: string; intervalMinutes?: number };
  nodes: WorkflowTemplateNode[];
  edges: WorkflowTemplateEdge[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'weekly-project-triage',
    name: 'Wöchentliche Projekt-Triage',
    description:
      'Jeden Montag 09:00: Agent analysiert offene Todos im Projekt, schlägt eine Top-3-Priorisierung vor und hinterlegt das Ergebnis als Chat-Session.',
    category: 'triage',
    supportedScopes: [WorkflowScope.PROJECT],
    trigger: { type: 'schedule', cron: '0 9 * * 1' },
    nodes: [
      {
        id: 'trigger',
        type: 'trigger.schedule',
        label: 'Wöchentlich (Mo 09:00)',
        position: { x: 80, y: 120 },
        config: {},
      },
      {
        id: 'analyze',
        type: 'agent.task',
        label: 'Todos analysieren',
        position: { x: 360, y: 120 },
        config: {
          prompt:
            'Lies die offenen Todos in diesem Projekt und schlage eine Top-3-Priorisierung für diese Woche vor. Begründe jede Priorisierung kurz und benenne mögliche Blocker.',
          allowedTools: ['todo_list', 'todo_get', 'milestone_list', 'project_get'],
          timeoutMs: 90_000,
          maxToolIterations: 5,
        },
      },
    ],
    edges: [
      { id: 'trigger-analyze', source: 'trigger', target: 'analyze', branch: 'success' },
    ],
  },
  {
    id: 'monthly-customer-check',
    name: 'Monatlicher Kunden-Check',
    description:
      'Am Ersten jedes Monats 09:00: Agent prüft offene Kundenpunkte, Monitoring-Status und legt eine Zusammenfassung als Chat-Session ab.',
    category: 'review',
    supportedScopes: [WorkflowScope.CUSTOMER],
    trigger: { type: 'schedule', cron: '0 9 1 * *' },
    nodes: [
      {
        id: 'trigger',
        type: 'trigger.schedule',
        label: 'Monatlich (1. um 09:00)',
        position: { x: 80, y: 120 },
        config: {},
      },
      {
        id: 'review',
        type: 'agent.task',
        label: 'Kundenstatus zusammenfassen',
        position: { x: 360, y: 120 },
        config: {
          prompt:
            'Erzeuge eine Status-Zusammenfassung für diesen Kunden: offene Quests, Monitoring-Health, jüngste Releases. Liste konkrete nächste Schritte für die kommende Woche.',
          allowedTools: ['todo_list', 'customer_get', 'monitor_list', 'monitor_summary', 'release_list'],
          timeoutMs: 120_000,
          maxToolIterations: 6,
        },
      },
    ],
    edges: [
      { id: 'trigger-review', source: 'trigger', target: 'review', branch: 'success' },
    ],
  },
  {
    id: 'daily-status-with-followup',
    name: 'Täglicher Projekt-Status mit Follow-up-Quest',
    description:
      'Jeden Werktag 08:00: Agent erzeugt eine kurze Statusnotiz im Projekt-Chat und legt — falls relevant — eine Follow-up-Quest an.',
    category: 'monitoring',
    supportedScopes: [WorkflowScope.PROJECT],
    trigger: { type: 'schedule', cron: '0 8 * * 1-5' },
    nodes: [
      {
        id: 'trigger',
        type: 'trigger.schedule',
        label: 'Werktags 08:00',
        position: { x: 80, y: 120 },
        config: {},
      },
      {
        id: 'status',
        type: 'agent.task',
        label: 'Status zusammenfassen',
        position: { x: 360, y: 120 },
        config: {
          prompt:
            'Erstelle einen Tagesstatus für dieses Projekt: was wurde gestern geschlossen, was steht heute an, gibt es Blocker? Antworte in maximal 6 Stichpunkten.',
          allowedTools: ['todo_list', 'commit_list', 'milestone_list'],
          timeoutMs: 60_000,
          maxToolIterations: 4,
        },
      },
      {
        id: 'log',
        type: 'action.log',
        label: 'In Activity-Log schreiben',
        position: { x: 640, y: 120 },
        config: { level: 'info', message: 'Tagesstatus-Workflow ausgeführt' },
      },
    ],
    edges: [
      { id: 'trigger-status', source: 'trigger', target: 'status', branch: 'success' },
      { id: 'status-log', source: 'status', target: 'log', branch: 'success' },
    ],
  },
  {
    id: 'release-checklist',
    name: 'Release-Checkliste',
    description:
      'Manueller Trigger: legt eine Standard-Release-Checkliste als Todo an (Tests, Changelog, Manual, Deployment-Notes).',
    category: 'release',
    supportedScopes: [WorkflowScope.PROJECT],
    trigger: { type: 'manual' },
    nodes: [
      {
        id: 'trigger',
        type: 'trigger.manual',
        label: 'Manueller Start',
        position: { x: 80, y: 120 },
        config: {},
      },
      {
        id: 'create-todo',
        type: 'action.todo-create',
        label: 'Release-Checkliste anlegen',
        position: { x: 360, y: 120 },
        config: {
          title: 'Release-Checkliste',
          description:
            '- [ ] Tests grün auf Main\n- [ ] Changelog ergänzt\n- [ ] Manual / Doku aktualisiert\n- [ ] Deployment-Notes vorbereitet\n- [ ] Stakeholder informiert',
          priority: 'high',
          tags: ['release'],
        },
      },
      {
        id: 'notify',
        type: 'action.notify',
        label: 'Benachrichtigung',
        position: { x: 640, y: 120 },
        config: {
          title: 'Release vorbereiten',
          body: 'Eine neue Release-Checkliste wurde erstellt — bitte arbeite die Punkte ab.',
        },
      },
    ],
    edges: [
      { id: 'trigger-todo', source: 'trigger', target: 'create-todo', branch: 'success' },
      { id: 'todo-notify', source: 'create-todo', target: 'notify', branch: 'success' },
    ],
  },
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

export function listTemplatesPublic(): Array<{
  id: string;
  name: string;
  description: string;
  category: string;
  supportedScopes: string[];
  triggerType: string;
  nodeCount: number;
}> {
  return WORKFLOW_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    supportedScopes: t.supportedScopes,
    triggerType: t.trigger.type,
    nodeCount: t.nodes.length,
  }));
}
