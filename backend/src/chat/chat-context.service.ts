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

    const systemPrompt = `${rolePromptBlock}Du bist ein technischer Assistent für ${projectId ? `das Softwareprojekt "${ownerName}"` : `den Kunden "${ownerName}"`}.
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
}
