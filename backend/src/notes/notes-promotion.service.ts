import { BadRequestException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ChatLlmService, type LlmMessage } from '../chat/chat-llm.service';
import { ProjectsService } from '../projects/projects.service';
import { CustomersService } from '../customers/customers.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { SnippetsService } from '../snippets/snippets.service';
import { TodosService } from '../todos/todos.service';
import { ResearchService } from '../research/research.service';
import { ManualsService } from '../manuals/manuals.service';
import { NotesService, type NoteWithIdle } from './notes.service';
import type { Note } from './schemas/note.schema';

/** Single source of truth for the promotion targets — used for parsing *and* dispatch. */
export const PROMOTION_ENTITY_TYPES = [
  'knowledge',
  'snippet',
  'todo',
  'research',
  'manual',
] as const;

export type PromotionEntityType = (typeof PROMOTION_ENTITY_TYPES)[number];

export interface PromotionEvent {
  type: 'status' | 'token' | 'proposal' | 'error' | 'done';
  [key: string]: unknown;
}

export interface PromotionProposal {
  entityType: PromotionEntityType;
  projectId: string | null;
  customerId: string | null;
  title: string;
  tags?: string[];
  reasoning?: string;
}

/** The projects/customers as they are rendered into the system prompt. */
interface PromptProject {
  id: string;
  name: string;
  techStack: string[];
}

interface PromptCustomer {
  id: string;
  name: string;
}

const MAX_PARSE_RETRIES = 3;
const MAX_NOTE_CHARS_FOR_PROMPT = 8000;

@Injectable()
export class NotesPromotionService {
  private readonly logger = new Logger(NotesPromotionService.name);

  constructor(
    private readonly notesService: NotesService,
    @Inject(forwardRef(() => ChatLlmService))
    private readonly llm: ChatLlmService,
    private readonly projectsService: ProjectsService,
    private readonly customersService: CustomersService,
    private readonly knowledgeService: KnowledgeService,
    private readonly snippetsService: SnippetsService,
    private readonly todosService: TodosService,
    private readonly researchService: ResearchService,
    private readonly manualsService: ManualsService,
  ) {}

  /**
   * Stream the agent analysis as SSE events. Yields:
   *  - {type: 'status', phase: 'loading'|'analyzing'}
   *  - {type: 'token', text: '...'}
   *  - {type: 'proposal', proposal: PromotionProposal}
   *  - {type: 'error', message: '...'} on failure
   *  - {type: 'done'}
   */
  async *analyze(userId: string, noteId: string, signal?: AbortSignal): AsyncIterable<PromotionEvent> {
    yield { type: 'status', phase: 'loading' };

    // 1. Load the note (user-scoped — throws 404 if foreign).
    const noteDoc = await this.notesService.findOne(userId, noteId);
    const note: Note = noteDoc.toObject();

    // 2. Load available projects + customers (scope is enforced via RequestContext).
    const [projects, customers] = await Promise.all([
      this.projectsService.findAll(true).catch(() => []),
      this.customersService.findAll({ includeArchived: false }).catch(() => []),
    ]);

    const projectsForPrompt: PromptProject[] = projects.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      techStack: Array.isArray(p.techStack) ? p.techStack.slice(0, 10) : [],
    }));
    const customersForPrompt: PromptCustomer[] = customers.map((c) => ({
      id: c._id.toString(),
      name: c.name,
    }));

    // 3. Increment attempt counter (best-effort — don't block on this).
    await this.notesService
      .incrementPromotionAttempts(userId, noteId)
      .catch((err: unknown) =>
        this.logger.warn(`Failed to increment promotionAttempts: ${errorMessage(err)}`),
      );

    yield { type: 'status', phase: 'analyzing' };

    const systemPrompt = buildSystemPrompt(projectsForPrompt, customersForPrompt);
    const truncatedNoteContent = note.content.slice(0, MAX_NOTE_CHARS_FOR_PROMPT);
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Notiz-Titel: ${note.title}\n\nNotiz-Inhalt:\n${truncatedNoteContent}`,
      },
    ];

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_PARSE_RETRIES; attempt++) {
      if (signal?.aborted) {
        yield { type: 'error', message: 'aborted' };
        return;
      }
      let buffered = '';
      try {
        for await (const token of this.llm.streamChat(messages, { signal, temperature: 0.2 })) {
          if (signal?.aborted) {
            yield { type: 'error', message: 'aborted' };
            return;
          }
          buffered += token;
          // Only forward tokens on the first attempt — retries are noisy.
          if (attempt === 1) yield { type: 'token', text: token };
        }
      } catch (err) {
        const message = errorMessage(err);
        this.logger.warn(`Promotion LLM stream failed (attempt ${attempt}): ${message}`);
        lastError = message;
        // If the LLM is unreachable, don't retry.
        if (message.toLowerCase().includes('no chat llm endpoint')) {
          yield { type: 'error', message: 'LLM endpoint not configured' };
          return;
        }
        continue;
      }
      const parsed = tryParseProposal(buffered, projectsForPrompt, customersForPrompt);
      if (parsed) {
        yield { type: 'proposal', proposal: parsed };
        yield { type: 'done' };
        return;
      }
      // Append a reminder for the next attempt.
      lastError = 'malformed JSON response';
      messages.push({ role: 'assistant', content: buffered.slice(-1000) });
      messages.push({
        role: 'user',
        content:
          'Antworte AUSSCHLIESSLICH als gültiges JSON gemäß dem oben angegebenen Schema, ohne Erklärungstext, ohne Markdown-Codeblöcke. Wenn du keine eindeutige Zuordnung findest, setze projectId und customerId auf null.',
      });
    }

    yield {
      type: 'error',
      message: lastError ?? 'agent failed to produce a valid proposal',
    };
  }

  /**
   * Commit the promotion: create the target entity, mark the note as promoted/archived.
   */
  async commit(
    userId: string,
    noteId: string,
    payload: {
      entityType: PromotionEntityType;
      projectId?: string;
      customerId?: string;
      title: string;
      tags?: string[];
      reasoning?: string;
    },
  ): Promise<{ promotedTo: NoteWithIdle['promotedTo']; entityLink: string }> {
    const noteDoc = await this.notesService.findOne(userId, noteId);
    if (noteDoc.archived) {
      throw new BadRequestException('Note is already archived');
    }

    const content = noteDoc.content;
    const tags = payload.tags ?? [];
    const projectId = payload.projectId || undefined;
    const customerId = payload.customerId || undefined;

    if (!projectId && !customerId && payload.entityType !== 'knowledge') {
      throw new BadRequestException(
        `entityType '${payload.entityType}' requires either projectId or customerId`,
      );
    }

    // Guard before the switch: the switch below is exhaustive over
    // PromotionEntityType, so a `default:` branch would be dead code that TS
    // narrows to `never`. Callers that bypass the DTO validation still get a 400.
    if (!PROMOTION_ENTITY_TYPES.includes(payload.entityType)) {
      throw new BadRequestException(`Unknown entityType: ${payload.entityType}`);
    }

    let entityId: string;
    let entityLink: string;

    switch (payload.entityType) {
      case 'knowledge': {
        const scope: 'global' | 'project' | 'customer' = projectId
          ? 'project'
          : customerId
            ? 'customer'
            : 'global';
        const created = await this.knowledgeService.create({
          projectId,
          customerId,
          scope,
          topic: payload.title,
          content,
          tags,
        });
        entityId = created._id.toString();
        entityLink = projectId
          ? `/projects/${projectId}?tab=knowledge&knowledgeId=${entityId}`
          : customerId
            ? `/customers/${customerId}?tab=knowledge&knowledgeId=${entityId}`
            : `/knowledge/${entityId}`;
        break;
      }
      case 'snippet': {
        const created = await this.snippetsService.create({
          projectId,
          customerId,
          title: payload.title,
          language: 'text',
          code: content,
          tags,
        });
        entityId = created._id.toString();
        entityLink = projectId
          ? `/projects/${projectId}?tab=snippets&snippetId=${entityId}`
          : `/customers/${customerId}?tab=snippets&snippetId=${entityId}`;
        break;
      }
      case 'todo': {
        if (!projectId && !customerId) {
          throw new BadRequestException('todo requires projectId or customerId');
        }
        const created = await this.todosService.create({
          projectId,
          customerId,
          title: payload.title,
          description: content,
          tags,
        });
        entityId = created._id.toString();
        entityLink = `/todos/${entityId}`;
        break;
      }
      case 'research': {
        const created = await this.researchService.create({
          projectId,
          customerId,
          title: payload.title,
          content,
          tags,
        });
        entityId = created._id.toString();
        entityLink = projectId
          ? `/projects/${projectId}?tab=research&researchId=${entityId}`
          : `/customers/${customerId}?tab=research&researchId=${entityId}`;
        break;
      }
      case 'manual': {
        const created = await this.manualsService.create({
          projectId,
          customerId,
          title: payload.title,
          content,
        });
        entityId = created._id.toString();
        entityLink = projectId
          ? `/projects/${projectId}?tab=manual&manualId=${entityId}`
          : `/customers/${customerId}?tab=manual&manualId=${entityId}`;
        break;
      }
    }

    const updated = await this.notesService.markPromoted(userId, noteId, {
      entityType: payload.entityType,
      entityId,
      projectId,
      customerId,
    });

    return {
      promotedTo: updated.promotedTo,
      entityLink,
    };
  }
}

// --- helpers -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `Array.isArray` widens `unknown` to `any[]`; this keeps the elements `unknown`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Best-effort message extraction from a caught value of unknown shape. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (isRecord(err)) {
    const message = asString(err.message);
    if (message) return message;
  }
  return typeof err === 'string' ? err : String(err);
}

function buildSystemPrompt(projects: PromptProject[], customers: PromptCustomer[]): string {
  const projectsBlock =
    projects.length > 0
      ? projects
          .map(
            (p) =>
              `- id: ${p.id} | name: ${p.name}${p.techStack.length > 0 ? ` | tech: ${p.techStack.join(', ')}` : ''}`,
          )
          .join('\n')
      : '(keine Projekte verfügbar)';
  const customersBlock =
    customers.length > 0
      ? customers.map((c) => `- id: ${c.id} | name: ${c.name}`).join('\n')
      : '(keine Kunden verfügbar)';

  return `Du bist ein DevGrimoire-Notizen-Archivar. Analysiere die folgende Notiz und schlage genau eine Ziel-Entität sowie eine Projekt- oder Kundenzuordnung vor.

Verfügbare Entity-Types:
- knowledge: langlebiges Projekt-/Kundenwissen (Architektur, Patterns, Erkenntnisse)
- snippet: wiederverwendbare Text-/Code-Bausteine
- todo: konkrete Aufgabe oder Bug
- research: zeitpunktbezogene Recherche mit Quellen
- manual: Handbuch-Kapitel (Setup, FAQ, How-To)

Verfügbare Projekte:
${projectsBlock}

Verfügbare Kunden:
${customersBlock}

Antworte AUSSCHLIESSLICH als gültiges JSON, ohne Erklärungstext, ohne Markdown-Codeblöcke. Schema:
{
  "entityType": "knowledge" | "snippet" | "todo" | "research" | "manual",
  "projectId": "<id-aus-der-liste>" | null,
  "customerId": "<id-aus-der-liste>" | null,
  "title": "<kurzer prägnanter Titel>",
  "tags": ["<tag>", "..."],
  "reasoning": "<1-2 Sätze warum>"
}

Regeln:
- Genau eines von projectId/customerId sollte gesetzt sein (oder beide null).
- Wenn keine eindeutige Zuordnung möglich ist: projectId und customerId auf null setzen.
- projectId/customerId müssen EXAKT eine ID aus den obigen Listen sein, sonst null.
- Wähle entityType nach Inhalt der Notiz, nicht nach Länge.`;
}

function tryParseProposal(
  raw: string,
  projects: Array<{ id: string }>,
  customers: Array<{ id: string }>,
): PromotionProposal | null {
  const validProjectIds = new Set(projects.map((p) => p.id));
  const validCustomerIds = new Set(customers.map((c) => c.id));

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip optional Markdown code fences.
  let body = trimmed;
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) body = fenceMatch[1].trim();

  // Find the first { … last } pair.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // `find` yields the literal union type — no assertion needed.
  const rawEntityType = parsed.entityType;
  const entityType = PROMOTION_ENTITY_TYPES.find((candidate) => candidate === rawEntityType);
  if (!entityType) return null;

  const rawProjectId = asString(parsed.projectId);
  const projectId =
    rawProjectId !== undefined && validProjectIds.has(rawProjectId) ? rawProjectId : null;

  const rawCustomerId = asString(parsed.customerId);
  let customerId =
    rawCustomerId !== undefined && validCustomerIds.has(rawCustomerId) ? rawCustomerId : null;
  // If both are set, prefer project (knowledge/research/manual/snippet/todo)
  if (projectId && customerId) customerId = null;

  const rawTitle = asString(parsed.title)?.trim();
  const title = rawTitle ? rawTitle.slice(0, 200) : 'Notiz';

  const rawTags = parsed.tags;
  const tags = isUnknownArray(rawTags)
    ? rawTags
        .map((tag) => asString(tag)?.trim())
        .filter((tag): tag is string => Boolean(tag))
        .slice(0, 20)
    : undefined;

  const reasoning = asString(parsed.reasoning)?.trim().slice(0, 2000);

  return { entityType, projectId, customerId, title, tags, reasoning };
}
