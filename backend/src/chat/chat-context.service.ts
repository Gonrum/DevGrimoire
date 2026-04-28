import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { RagService } from '../rag/rag.service';
import { ChatMessage, ChatContextRef } from './schemas/chat-session.schema';
import { LlmMessage, LlmImageInput } from './chat-llm.service';
import { WorkspaceDocument } from '../workspaces/schemas/workspace.schema';

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
    private readonly rag: RagService,
  ) {}

  async build(
    projectId: string,
    userMessage: string,
    history: ChatMessage[],
    options: {
      topK?: number;
      historyLimit?: number;
      toolsEnabled?: boolean;
      attachments?: AttachmentForContext[];
      images?: LlmImageInput[];
      activeWorkspace?: WorkspaceDocument | null;
    } = {},
  ): Promise<ContextBuildResult> {
    const toolsEnabled = options.toolsEnabled ?? false;
    const topK = options.topK ?? (toolsEnabled ? 3 : 6);
    const historyLimit = options.historyLimit ?? 10;
    const attachments = options.attachments ?? [];
    const images = options.images;
    const activeWorkspace = options.activeWorkspace ?? null;

    const project = await this.projects.findById(projectId);

    let ragResults: Awaited<ReturnType<RagService['search']>> = [];
    try {
      ragResults = await this.rag.search(userMessage, projectId, undefined, topK);
    } catch (err) {
      this.logger.warn(`RAG search unavailable: ${(err as Error).message}`);
    }

    const contextSection =
      ragResults.length > 0
        ? ragResults
            .map((r, i) => `(${i + 1}) [${r.entity}] ${r.title}\n${r.content.slice(0, 400)}`)
            .join('\n\n')
        : '(keine relevanten Treffer im RAG-Index)';

    const techStack = project.techStack?.join(', ') || '-';
    const description = project.description || '-';
    const instructions =
      project.instructions && project.instructions.trim()
        ? `\n\n## Projektspezifische Instruktionen\n${project.instructions.trim()}`
        : '';

    const toolUsageHint = toolsEnabled
      ? `

Du hast Tools, mit denen du Live-Daten aus dem Projekt abrufen kannst (z.B. \`todo_list\`, \`milestone_list\`, \`rag_search\`, \`knowledge_search\`).
Wenn der Nutzer konkrete Daten verlangt (offene Todos, Milestones, Änderungshistorie, spezifische Dokumente), **rufe die passenden Tools auf** statt aus dem unten stehenden Kontext zu raten.
Die \`projectId\` des aktuellen Kontext-Projekts ist: ${projectId}. Du kannst diese ID verwenden oder weglassen — das System setzt sie automatisch.`
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

    const systemPrompt = `Du bist ein technischer Assistent für das Softwareprojekt "${project.name}".
Antworte präzise und auf Deutsch. Nutze den bereitgestellten Projektkontext als Quelle.
Wenn der Kontext die Frage nicht eindeutig beantwortet, sag das klar statt zu raten.
Verweise nach Möglichkeit auf konkrete Einträge (z.B. "laut (2) im Kontext").${toolUsageHint}

# Projekt
- Name: ${project.name}
- Beschreibung: ${description}
- Tech-Stack: ${techStack}${instructions}

# Relevanter Kontext aus dem Projekt
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
