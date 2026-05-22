import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { CustomersService } from '../customers/customers.service';
import { RagService } from '../rag/rag.service';
import { ChatMessage, ChatContextRef } from './schemas/chat-session.schema';
import { LlmMessage, LlmImageInput } from './chat-llm.service';
import { WorkspaceDocument } from '../workspaces/schemas/workspace.schema';
import { AgentRolesService } from '../agent-roles/agent-roles.service';

function shortenRepo(url?: string): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function workspaceContextLine(ws: WorkspaceDocument): string {
  const parts: string[] = [`name: ${ws.name}`, `path: ${ws.path}`, `id: ${ws._id.toString()}`];
  const repo = shortenRepo(ws.repoUrl);
  if (repo) parts.push(`repo: ${repo} (${ws.branch || 'main'})`);
  return `[Active Workspace | ${parts.join(' | ')}]`;
}

export interface ContextBuildResult {
  systemPrompt: string;
  messages: LlmMessage[];
  contextRefs: ChatContextRef[];
  images?: LlmImageInput[];
  attachmentStats?: {
    /** Total number of attachments considered. */
    total: number;
    /** Number actually injected into the prompt (after budget trimming). */
    included: number;
    /** Attachments dropped because global budget was exhausted. */
    droppedByBudget: number;
    /** Sum of extracted text lengths that made it into the prompt. */
    totalChars: number;
  };
}

export interface AttachmentForContext {
  fileName: string;
  content: string;
  /** For diagnostics/persistence. */
  attachmentId?: string;
  size?: number;
}

/** Per-file hard cap on text injected into a single prompt block. */
const PER_ATTACHMENT_CHAR_CAP = 20_000;

/** Global budget across all attachments in one message. */
const TOTAL_ATTACHMENT_CHAR_BUDGET = 80_000;

@Injectable()
export class ChatContextService {
  private readonly logger = new Logger(ChatContextService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly customers: CustomersService,
    private readonly rag: RagService,
    private readonly agentRoles: AgentRolesService,
  ) {}

  async build(
    owner: string | { projectId?: string; customerId?: string },
    userMessage: string,
    history: ChatMessage[],
    options: {
      topK?: number;
      historyLimit?: number;
      toolsEnabled?: boolean;
      attachments?: AttachmentForContext[];
      images?: LlmImageInput[];
      activeWorkspace?: WorkspaceDocument | null;
      /** Optional agent-role id (T-264). Prepends role-prompt block + intersects allowlist downstream. */
      agentRoleId?: string;
      /** Briefing Mode (T-424). Prepends a Briefing-Block that steers the LLM to elicit requirements iteratively. */
      briefingMode?: boolean;
    } = {},
  ): Promise<ContextBuildResult> {
    const ownerObj = typeof owner === 'string' ? { projectId: owner } : owner;
    const projectId = ownerObj.projectId;
    const customerId = ownerObj.customerId;
    if (!projectId && !customerId) {
      throw new Error('chat context requires projectId or customerId');
    }
    const toolsEnabled = options.toolsEnabled ?? false;
    const topK = options.topK ?? (toolsEnabled ? 3 : 6);
    const historyLimit = options.historyLimit ?? 10;
    const attachments = options.attachments ?? [];
    const images = options.images;
    const activeWorkspace = options.activeWorkspace ?? null;

    let ownerName = '';
    let techStack = '-';
    let description = '-';
    let instructions = '';
    if (projectId) {
      const project = await this.projects.findById(projectId);
      ownerName = project.name;
      techStack = project.techStack?.join(', ') || '-';
      description = project.description || '-';
      instructions =
        project.instructions && project.instructions.trim()
          ? `\n\n## Projektspezifische Instruktionen\n${project.instructions.trim()}`
          : '';
    } else if (customerId) {
      const customer = await this.customers.findById(customerId);
      ownerName = customer.name;
      description = customer.description || '-';
    }

    let ragResults: Awaited<ReturnType<RagService['search']>> = [];
    try {
      ragResults = await this.rag.search(userMessage, projectId, undefined, topK, customerId);
    } catch (err) {
      this.logger.warn(`RAG search unavailable: ${(err as Error).message}`);
    }

    const contextSection =
      ragResults.length > 0
        ? ragResults
            .map((r, i) => `(${i + 1}) [${r.entity}] ${r.title}\n${r.content.slice(0, 400)}`)
            .join('\n\n')
        : '(keine relevanten Treffer im RAG-Index)';

    const ownerLabel = projectId ? 'Projekt' : 'Kunde';
    const ownerIdLabel = projectId ? 'projectId' : 'customerId';
    const ownerIdValue = projectId || customerId || '';

    const toolUsageHint = toolsEnabled
      ? `

Du hast Tools, mit denen du Live-Daten aus dem ${ownerLabel} abrufen kannst (z.B. \`todo_list\`, \`milestone_list\`, \`rag_search\`, \`knowledge_search\`).
Wenn der Nutzer konkrete Daten verlangt (offene Todos, Milestones, Änderungshistorie, spezifische Dokumente), **rufe die passenden Tools auf** statt aus dem unten stehenden Kontext zu raten.
Die \`${ownerIdLabel}\` des aktuellen Kontextes ist: ${ownerIdValue}. Du kannst diese ID verwenden oder weglassen — das System setzt sie automatisch.`
      : '';

    // Attachments — truncate per file and enforce a global budget so a runaway
    // upload can't blow out the prompt window.
    const attachmentStats = {
      total: attachments.length,
      included: 0,
      droppedByBudget: 0,
      totalChars: 0,
    };
    const attachmentBlocks: string[] = [];
    let remainingBudget = TOTAL_ATTACHMENT_CHAR_BUDGET;
    for (const att of attachments) {
      if (remainingBudget <= 0) {
        attachmentStats.droppedByBudget += 1;
        continue;
      }
      const rawLen = att.content.length;
      const perFileCap = Math.min(PER_ATTACHMENT_CHAR_CAP, remainingBudget);
      const truncated = rawLen > perFileCap ? att.content.slice(0, perFileCap) : att.content;
      const suffix =
        rawLen > truncated.length
          ? `\n…[abgeschnitten — Gesamtgröße ${rawLen} Zeichen]`
          : '';
      attachmentBlocks.push(
        `### Datei: ${att.fileName}\n\`\`\`\n${truncated}${suffix}\n\`\`\``,
      );
      remainingBudget -= truncated.length;
      attachmentStats.included += 1;
      attachmentStats.totalChars += truncated.length;
    }

    const attachmentSection = attachmentBlocks.length > 0
      ? `\n\n# Angehängte Dateien\nDer Nutzer hat ${attachmentStats.included}/${attachmentStats.total} Datei(en) angehängt. Der Inhalt steht unten. Beziehe dich bei Bedarf explizit auf den Dateinamen.\n\n${attachmentBlocks.join('\n\n')}`
      : '';

    const rolePromptBlock = this.agentRoles.buildRolePromptBlock(options.agentRoleId);

    const briefingBlock = options.briefingMode
      ? `# Briefing Mode
Du bist im Briefing-Modus. Der User beschreibt eine Feature-Idee — möglicherweise als Markdown, möglicherweise nur in Stichworten.

Vorgehen:
1. Erfasse das Ziel ("Was soll erreicht werden?").
2. Strukturiere die Anforderung in User Stories (Format "Als ... möchte ich ...").
3. Schlage Akzeptanzkriterien als Checkliste vor.
4. Markiere Out-of-Scope (was NICHT Teil ist).
5. Identifiziere Edge Cases und offene Fragen.

Stelle gezielte Klärungsfragen. Wiederhole nicht, was der User schon gesagt hat — frage nach dem, was noch fehlt.

Wenn der User dir signalisiert "GO" / "okay" / "erstelle Milestone": Rufe \`milestone_create_with_todos\` auf mit der projectId (sie ist im obigen Projektkontext) und den finalen Todos inkl. aller Quest-Felder. Bestätige danach mit der erzeugten Milestone-Nummer.

`
      : '';

    const systemPrompt = `${briefingBlock}${rolePromptBlock}Du bist ein technischer Assistent für ${projectId ? `das Softwareprojekt "${ownerName}"` : `den Kunden "${ownerName}"`}.
Antworte präzise und auf Deutsch. Nutze den bereitgestellten ${projectId ? 'Projektkontext' : 'Kundenkontext'} als Quelle.
Wenn der Kontext die Frage nicht eindeutig beantwortet, sag das klar statt zu raten.
Verweise nach Möglichkeit auf konkrete Einträge (z.B. "laut (2) im Kontext").${toolUsageHint}

# ${ownerLabel}
- Name: ${ownerName}
- Beschreibung: ${description}${projectId ? `\n- Tech-Stack: ${techStack}` : ''}${instructions}

# Relevanter Kontext
${contextSection}${attachmentSection}`;

    const historyMessages: LlmMessage[] = history
      .slice(-historyLimit)
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    // Prepend the workspace context line to THIS turn's user message only —
    // we deliberately don't rewrite history so older turns reflect what was
    // active back then, not now.
    const userContent = activeWorkspace
      ? `${workspaceContextLine(activeWorkspace)}\n\n${userMessage}`
      : userMessage;

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: userContent },
    ];

    const contextRefs: ChatContextRef[] = ragResults.map((r) => ({
      entity: r.entity,
      entityId: r.id,
      title: r.title,
      score: r.score,
    }));

    return {
      systemPrompt,
      messages,
      contextRefs,
      attachmentStats,
      images: images && images.length > 0 ? images : undefined,
    };
  }

  /**
   * Multi-project research-mode context builder. RAG-searches per project in
   * parallel, dedupes by sourceId, and assembles a system prompt that frames
   * the assistant as a researcher across the listed projects.
   *
   * No customer scoping (research is project-centric). Attachments not used —
   * research sessions don't accept file uploads yet (YAGNI). Tools allowed.
   */
  async buildResearch(
    projectIds: string[],
    userMessage: string,
    history: ChatMessage[],
    options: {
      topK?: number;
      historyLimit?: number;
      toolsEnabled?: boolean;
      agentRoleId?: string;
    } = {},
  ): Promise<ContextBuildResult> {
    if (projectIds.length === 0) {
      throw new Error('research context requires at least one projectId');
    }
    const toolsEnabled = options.toolsEnabled ?? false;
    const topK = options.topK ?? (toolsEnabled ? 3 : 6);
    const historyLimit = options.historyLimit ?? 10;

    // Fetch project metadata in parallel.
    const projects = await Promise.all(
      projectIds.map((pid) => this.projects.findById(pid).catch(() => null)),
    );
    const validProjects = projects.filter((p): p is NonNullable<typeof p> => p !== null);
    if (validProjects.length === 0) {
      throw new Error('none of the projectIds resolved to an accessible project');
    }

    // RAG search per project, parallel, then merge by sourceId keeping highest score.
    const perProjectResults = await Promise.all(
      validProjects.map((p) =>
        this.rag
          .search(userMessage, p._id.toString(), undefined, topK)
          .catch((err) => {
            this.logger.warn(`RAG unavailable for ${p.name}: ${(err as Error).message}`);
            return [] as Awaited<ReturnType<RagService['search']>>;
          }),
      ),
    );

    const dedupBySource = new Map<string, { hit: Awaited<ReturnType<RagService['search']>>[number]; projectName: string }>();
    perProjectResults.forEach((results, idx) => {
      const projectName = validProjects[idx].name;
      for (const hit of results) {
        const existing = dedupBySource.get(hit.id);
        if (!existing || hit.score > existing.hit.score) {
          dedupBySource.set(hit.id, { hit, projectName });
        }
      }
    });

    const mergedHits = [...dedupBySource.values()]
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, topK);

    const contextSection =
      mergedHits.length > 0
        ? mergedHits
            .map(
              ({ hit, projectName }, i) =>
                `(${i + 1}) [${hit.entity} · ${projectName}] ${hit.title}\n${hit.content.slice(0, 400)}`,
            )
            .join('\n\n')
        : '(keine relevanten Treffer im RAG-Index über die ausgewählten Projekte)';

    const projectList = validProjects
      .map((p) => `- ${p.name}${p.techStack?.length ? ` (${p.techStack.join(', ')})` : ''}`)
      .join('\n');

    const toolUsageHint = toolsEnabled
      ? `

Du hast Tools, mit denen du Live-Daten aus den Projekten abrufen kannst (z.B. \`todo_list\`, \`rag_search\`, \`knowledge_search\`).
Setze \`projectId\` bei Tool-Aufrufen auf eines der Projekt-IDs: ${validProjects.map((p) => p._id.toString()).join(', ')}.`
      : '';

    const rolePromptBlock = this.agentRoles.buildRolePromptBlock(options.agentRoleId);

    const systemPrompt = `${rolePromptBlock}Du bist ein technischer Recherche-Assistent für eine projektübergreifende Untersuchung.
Antworte präzise und auf Deutsch. Nutze den bereitgestellten Kontext aus den unten gelisteten Projekten als Quelle.
Wenn der Kontext die Frage nicht eindeutig beantwortet, sag das klar statt zu raten.
Verweise nach Möglichkeit auf konkrete Einträge (z.B. "laut (2) im Kontext, Projekt X").${toolUsageHint}

# Projekte im Scope
${projectList}

# Relevanter Kontext
${contextSection}`;

    const historyMessages: LlmMessage[] = history
      .slice(-historyLimit)
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: userMessage },
    ];

    const contextRefs: ChatContextRef[] = mergedHits.map(({ hit }) => ({
      entity: hit.entity,
      entityId: hit.id,
      title: hit.title,
      score: hit.score,
    }));

    return {
      systemPrompt,
      messages,
      contextRefs,
    };
  }
}
