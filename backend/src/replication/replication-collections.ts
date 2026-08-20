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
  /** Schlüssel im Full-Sync-Payload. Fehlt er, gilt der Collection-Name.
   *  Gesetzt wird er nur dort, wo der historisch gewachsene Key davon
   *  abweicht — diese Keys sind Übertragungsformat und dürfen sich nicht
   *  ändern (`check:replication-entity-maps` friert sie ein). */
  exportKey?: string;
}

export const REPLICATED_COLLECTIONS: ReplicatedCollection[] = [
  { className: 'Project', entity: 'project', collection: 'projects', appendOnly: false, exportKey: 'project' },
  { className: 'Todo', entity: 'todo', collection: 'todos', appendOnly: false },
  { className: 'Session', entity: 'session', collection: 'sessions', appendOnly: false },
  { className: 'Knowledge', entity: 'knowledge', collection: 'knowledges', appendOnly: false, exportKey: 'knowledge' },
  { className: 'Changelog', entity: 'changelog', collection: 'changelogs', appendOnly: false, exportKey: 'changelog' },
  { className: 'Milestone', entity: 'milestone', collection: 'milestones', appendOnly: false },
  { className: 'Manual', entity: 'manual', collection: 'manuals', appendOnly: false },
  { className: 'Research', entity: 'research', collection: 'researches', appendOnly: false, exportKey: 'research' },
  { className: 'Environment', entity: 'environment', collection: 'environments', appendOnly: false },
  { className: 'Secret', entity: 'secret', collection: 'secrets', appendOnly: false },
  { className: 'DbSchema', entity: 'schema', collection: 'dbschemas', appendOnly: false, exportKey: 'schemas' },
  { className: 'Dependency', entity: 'dependency', collection: 'dependencies', appendOnly: false },
  { className: 'Feature', entity: 'feature', collection: 'features', appendOnly: false },
  { className: 'Soul', entity: 'soul', collection: 'souls', appendOnly: false },
  /*
   * Harness (M-51/H1) — dieselbe Semantik wie Soul, absichtlich direkt daneben.
   *
   * **Am Code verifiziert, nicht angenommen** (T-443): `isEntryOptedIn()` in
   * `replication-sync-cursor.helpers.ts` sagt "No projects → never replicated",
   * und `extractProjectRefs()` liefert für ein Dokument ohne `projectId` genau
   * `projectId: null`. Daraus folgt:
   *
   *   - `scope: 'project'`  → repliziert, sobald das Projekt opt-in hat.
   *   - `scope: 'customer'` → repliziert **nicht**.
   *   - `scope: 'global'`   → repliziert **nicht**.
   *
   * Das ist exakt das Verhalten kunden-gebundener Souls heute: die tragen
   * ebenfalls nur `customerId` und fallen aus demselben Grund heraus. Die
   * globale und die Kundenebene sind damit pro Instanz zu pflegen — eine
   * Einschränkung, aber eine, die dem bestehenden Modell entspricht. Sie zu
   * ändern hiesse, das Per-Projekt-Opt-in selbst zu ändern (ausdrücklich
   * ausserhalb dieses Milestones).
   */
  { className: 'Harness', entity: 'harness', collection: 'harnesses', appendOnly: false },
  { className: 'Commit', entity: 'commit', collection: 'commits', appendOnly: true },
  { className: 'RecurringTask', entity: 'recurring-task', collection: 'recurringtasks', appendOnly: false, exportKey: 'recurringTasks' },
  { className: 'Snippet', entity: 'snippet', collection: 'snippets', appendOnly: false },
  { className: 'Attachment', entity: 'attachment', collection: 'attachments', appendOnly: false },
  { className: 'Activity', entity: 'activity', collection: 'activities', appendOnly: true },
  { className: 'Release', entity: 'release', collection: 'releases', appendOnly: false },
  { className: 'Question', entity: 'question', collection: 'questions', appendOnly: false },
  { className: 'OracleSuggestion', entity: 'oracle', collection: 'oraclesuggestions', appendOnly: false },
  { className: 'ValidationReport', entity: 'validation-report', collection: 'validationreports', appendOnly: false },
  { className: 'DocUpdateProposal', entity: 'doc-update-proposal', collection: 'docupdateproposals', appendOnly: false },
  { className: 'KnowledgeGraphEdge', entity: 'knowledge-graph-edge', collection: 'knowledgegraphedges', appendOnly: false },
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
  { className: 'SavedRequest', reason: 'API-Werkbank: speichert Auth (username/password/token) + Header im Klartext — Replikation würde Projekt-Credentials instanzübergreifend leaken. Erst nach Verschlüsselung (analog Secrets) reklassifizieren.' },
  { className: 'RequestCollection', reason: 'API-Werkbank: nur sinnvoll zusammen mit SavedRequest (exkludiert) — Feature bleibt vorerst instanzlokal' },
  { className: 'RequestHistoryEntry', reason: 'API-Werkbank: hochvolumige, TTL-ephemere Request/Response-Snapshots (Diagnose) — nicht projekt-inhaltlich, analog LogEntry' },
  { className: 'SshConnection', reason: 'Infra-Zugangsdaten, instanz-/umgebungsspezifisch (Home vs Firma erreichen andere Hosts)' },
  { className: 'KubeCluster', reason: 'Infra-Zugangsdaten, instanz-/umgebungsspezifisch (Home vs Firma erreichen andere Cluster)' },
  { className: 'KubeAudit', reason: 'Audit-Spur ist instanzlokal, wie SshAudit' },
  { className: 'WorkflowDefinition', reason: 'Referenziert instanzgebundene Secrets/Endpoints' },
  { className: 'WorkflowRun', reason: 'Workflow-Run-State, instanzgebunden' },
  { className: 'Workspace', reason: 'Lokaler Sidecar-Container-State (Clones, Scratch) — instanzgebunden' },
];

/**
 * Entity → physische Collection. Abgeleitet, nicht gepflegt: push, receive und
 * der Pull-Endpoint führten bis T-465 je eine eigene handgeschriebene Tabelle,
 * und alle drei hinkten der Registry um acht Entity-Typen hinterher (harness,
 * question, oracle, validation-report, doc-update-proposal,
 * knowledge-graph-edge, research-artifact, research-topic).
 *
 * Der Ausfall war lautlos: `buildPayload()` liefert für ein unbekanntes Entity
 * `null`, worauf der Push-Handler ohne Log und ohne Warteschlangen-Eintrag
 * zurückkehrt. Die Änderung galt als verschickt und war nirgends.
 *
 * `check:replication-entity-maps` hält die drei Pfade an dieser Ableitung fest.
 */
export const ENTITY_COLLECTION: Record<string, string> = Object.fromEntries(
  REPLICATED_COLLECTIONS.map((c) => [c.entity, c.collection]),
);

/**
 * Export-Key → Collection, für den Full-Sync. Eigener Namensraum als
 * {@link ENTITY_COLLECTION}: die Keys stehen als Objektschlüssel im
 * Payload zwischen zwei Instanzen und sind damit Übertragungsformat.
 *
 * Bis T-466 pflegten Sender (`SYNC_COLLECTIONS`) und Empfänger
 * (`exportCollectionMap`) je eine eigene Tabelle; beiden fehlten dieselben
 * neun Collections. Der Full-Sync ist der Bootstrap-Pfad — ein erstmalig
 * übertragenes Projekt kam ohne sie an.
 *
 * Unbekannte Keys sind unkritisch: der Empfänger iteriert über SEINE Tabelle
 * und greift sich `payload[key]`, überspringt also alles, was er nicht kennt,
 * statt den Batch abzulehnen. Eine neuere Sender-Version darf deshalb mehr
 * schicken als die Gegenstelle versteht.
 */
export const EXPORT_COLLECTION: Record<string, string> = Object.fromEntries(
  REPLICATED_COLLECTIONS.map((c) => [c.exportKey ?? c.collection, c.collection]),
);

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
