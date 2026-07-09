/**
 * Single source of truth for which collections replicate, consolidating the
 * previously scattered maps (push: ENTITY_COLLECTION, events-bus:
 * COLLECTION_ENTITY_MAP, full-sync: SYNC_COLLECTIONS).
 *
 * `className` = the @Schema class name (greppable from source — used by the
 * completeness guard). `collection` = the physical MongoDB collection name.
 * `appendOnly` collections are LWW-exempt (always upsert).
 *
 * Adding a new projectId-bearing schema without listing it here (or in
 * EXCLUDED_COLLECTIONS) fails the guard check — no silent gaps.
 */
export interface ReplicatedCollection {
  className: string;
  entity: string;
  collection: string;
  appendOnly: boolean;
  /** Multi-project entity keyed by `projectIds: ObjectId[]` (not a singular
   *  `projectId`). The log-writer populates the log entry's `projectIds`, and
   *  opt-in is "any of them enabled" (spec: "alles was ein Projekt enthält"). */
  multiProject?: boolean;
}

export const REPLICATED_COLLECTIONS: ReplicatedCollection[] = [
  { className: 'Project', entity: 'project', collection: 'projects', appendOnly: false },
  { className: 'Todo', entity: 'todo', collection: 'todos', appendOnly: false },
  { className: 'Session', entity: 'session', collection: 'sessions', appendOnly: false },
  { className: 'Knowledge', entity: 'knowledge', collection: 'knowledges', appendOnly: false },
  { className: 'Changelog', entity: 'changelog', collection: 'changelogs', appendOnly: false },
  { className: 'Milestone', entity: 'milestone', collection: 'milestones', appendOnly: false },
  { className: 'Manual', entity: 'manual', collection: 'manuals', appendOnly: false },
  { className: 'Research', entity: 'research', collection: 'researches', appendOnly: false },
  { className: 'Environment', entity: 'environment', collection: 'environments', appendOnly: false },
  { className: 'Secret', entity: 'secret', collection: 'secrets', appendOnly: false },
  { className: 'DbSchema', entity: 'schema', collection: 'dbschemas', appendOnly: false },
  { className: 'Dependency', entity: 'dependency', collection: 'dependencies', appendOnly: false },
  { className: 'Feature', entity: 'feature', collection: 'features', appendOnly: false },
  { className: 'Soul', entity: 'soul', collection: 'souls', appendOnly: false },
  { className: 'Commit', entity: 'commit', collection: 'commits', appendOnly: true },
  { className: 'RecurringTask', entity: 'recurring-task', collection: 'recurringtasks', appendOnly: false },
  { className: 'Snippet', entity: 'snippet', collection: 'snippets', appendOnly: false },
  { className: 'Attachment', entity: 'attachment', collection: 'attachments', appendOnly: false },
  { className: 'Activity', entity: 'activity', collection: 'activities', appendOnly: true },
  { className: 'Release', entity: 'release', collection: 'releases', appendOnly: false },
  { className: 'Question', entity: 'question', collection: 'questions', appendOnly: false },
  { className: 'OracleSuggestion', entity: 'oracle', collection: 'oraclesuggestions', appendOnly: false },
  { className: 'ValidationReport', entity: 'validation-report', collection: 'validationreports', appendOnly: false },
  { className: 'DocUpdateProposal', entity: 'doc-update-proposal', collection: 'docupdateproposals', appendOnly: false },
  { className: 'KnowledgeGraphEdge', entity: 'knowledge-graph-edge', collection: 'knowledgegraphedges', appendOnly: false },
  { className: 'ResearchSession', entity: 'research-session', collection: 'researchsessions', appendOnly: false, multiProject: true },
  { className: 'ResearchArtifact', entity: 'research-artifact', collection: 'researchartifacts', appendOnly: false, multiProject: false },
  { className: 'ResearchTopic', entity: 'research-topic', collection: 'researchtopics', appendOnly: false, multiProject: true },
];

/**
 * projectId-bearing schemas deliberately NOT replicated. Each needs a reason.
 * These are surfaced to the admin during rollout — adjust if a collection
 * should actually sync.
 */
export const EXCLUDED_COLLECTIONS: { className: string; reason: string }[] = [
  { className: 'ChatSession', reason: 'Lokale Chat-Sessions mit instanzgebundenen LLM-Endpoints' },
  { className: 'ChatActivity', reason: 'Chat-Aktivitätslog, instanzlokal' },
  { className: 'Counter', reason: 'Interne Sequenz-Zähler — instanzlokal, würde Nummern-Kollisionen erzeugen' },
  { className: 'CustomerProjectLink', reason: 'Customer-Domäne, separate Replikations-Entscheidung außerhalb dieses Features' },
  { className: 'Healthcheck', reason: 'Customer-skopiertes Monitoring, kein Projekt-Inhalt' },
  { className: 'LogEntry', reason: 'Hochvolumige lokale Diagnose-Logs — nicht projekt-inhaltlich' },
  { className: 'ReplicationDeadletter', reason: 'Interne Engine-Collection (Deadletter-Store) — darf sich nicht selbst replizieren' },
  { className: 'ReplicationLog', reason: 'Das Replikations-Log selbst (trägt projectId für Opt-in-Filterung) — interne Engine-Collection, darf sich nicht selbst replizieren (Rekursion)' },
  { className: 'ReplicationQueue', reason: 'Internes Legacy-Outbox — instanzlokal' },
  { className: 'SshConnection', reason: 'Infra-Zugangsdaten, instanz-/umgebungsspezifisch (Home vs Firma erreichen andere Hosts)' },
  { className: 'WorkflowDefinition', reason: 'Referenziert instanzgebundene Secrets/Endpoints' },
  { className: 'WorkflowRun', reason: 'Workflow-Run-State, instanzgebunden' },
  { className: 'Workspace', reason: 'Lokaler Sidecar-Container-State (Clones, Scratch) — instanzgebunden' },
];

const COLLECTION_SET = new Set(REPLICATED_COLLECTIONS.map((c) => c.collection));
const BY_COLLECTION = new Map(REPLICATED_COLLECTIONS.map((c) => [c.collection, c]));
const APPEND_ONLY = new Set(REPLICATED_COLLECTIONS.filter((c) => c.appendOnly).map((c) => c.collection));

export function isReplicatedCollection(collection: string): boolean {
  return COLLECTION_SET.has(collection);
}

export function getReplicatedByCollection(collection: string): ReplicatedCollection | undefined {
  return BY_COLLECTION.get(collection);
}

export function replicatedCollectionNames(): string[] {
  return REPLICATED_COLLECTIONS.map((c) => c.collection);
}

export function appendOnlyCollections(): Set<string> {
  return APPEND_ONLY;
}
