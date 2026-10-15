import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { PROJECT_CHANGED } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { WebSearchService } from '../web-search/services/web-search.service';
import { EndpointAllocator } from '../balancer/endpoint-allocator.service';
import { assertMoveTarget, canControlResearch, isAssigned } from './research-access';
import { prepareFiles } from './research-files';
import { ResearchLiveService } from './research-live.service';
import { ResearchQueueService } from './research-queue';
import { ResearchRunStore, type RunDoc } from './research-run-store';
import { ResearchStepsService } from './research-steps.service';
import { ResearchCustomerLookup, ResearchProjectLookup } from './research-targets';
import { TOPIC_LIMITS } from './research-config';
import type { ResearchDepth } from './research-types';

export interface StartInput {
  topics: string[];
  focus?: string;
  depth: ResearchDepth;
  files: Array<{ name: string; text: string }>;
  moveTargetHint?: string;
}

const QUESTION_MIN = 3;
const QUESTION_MAX = 500;

@Injectable()
export class ResearchControlService {
  constructor(
    private readonly store: ResearchRunStore,
    private readonly queue: ResearchQueueService,
    private readonly live: ResearchLiveService,
    private readonly steps: ResearchStepsService,
    private readonly webSearch: WebSearchService,
    private readonly allocator: EndpointAllocator,
    private readonly projects: ResearchProjectLookup,
    private readonly customers: ResearchCustomerLookup,
    private readonly events: EventEmitter2,
  ) {}

  async start(input: StartInput): Promise<string[]> {
    const topics = input.topics.map((t) => t.trim()).filter((t) => t.length > 0);
    if (topics.length < 1 || topics.length > TOPIC_LIMITS.maxTopics) {
      throw new BadRequestException(`1 bis ${TOPIC_LIMITS.maxTopics} Themen angeben`);
    }
    for (const t of topics) {
      if (t.length < TOPIC_LIMITS.minChars || t.length > TOPIC_LIMITS.maxChars) {
        throw new BadRequestException(`Jedes Thema braucht ${TOPIC_LIMITS.minChars} bis ${TOPIC_LIMITS.maxChars} Zeichen`);
      }
    }
    const focus = input.focus?.trim() || undefined;
    if (focus && focus.length > TOPIC_LIMITS.maxFocus) {
      throw new BadRequestException(`Fokus darf höchstens ${TOPIC_LIMITS.maxFocus} Zeichen haben`);
    }
    const files = prepareFiles(input.files);
    if (!(await this.webSearch.isEnabled())) throw new BadRequestException('Websuche ist nicht eingerichtet');
    if ((await this.allocator.poolCapacity('workflow')) <= 0) {
      throw new BadRequestException('Kein LLM-Endpunkt im Workflow-Pool verfügbar');
    }
    const actor = RequestContext.getUser();
    if (actor && !Types.ObjectId.isValid(actor.userId)) throw new BadRequestException('Ungültiger Benutzer');
    const ownerUserId = actor ? actor.userId : null;

    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < topics.length; i++) {
      ids.push(await this.store.create({
        ownerUserId,
        title: topics[i],
        ...(focus ? { focus } : {}),
        depth: input.depth,
        files: files.map((f) => ({ n: 0, name: f.name, text: f.text, notes: '' })),
        queuedAt: new Date(base + i),
        ...(input.moveTargetHint ? { moveTargetHint: input.moveTargetHint } : {}),
      }));
    }
    for (const id of ids) await this.queue.enqueue(id);
    return ids;
  }

  /** Lädt das Dokument; fehlend oder ohne Recht → 404 (keine Existenz-Auskunft). */
  async load(id: string): Promise<RunDoc> {
    const doc = await this.store.get(id);
    if (!doc || !canControlResearch(RequestContext.getUser(), doc)) throw new NotFoundException(`Recherche ${id} nicht gefunden`);
    return doc;
  }

  async statusOf(id: string): Promise<RunDoc['status']> {
    return (await this.load(id)).status;
  }

  async listSteps(id: string, limit?: number) {
    await this.load(id);
    return this.steps.list(id, limit);
  }

  private conflict(doc: RunDoc): ConflictException {
    return new ConflictException(`Recherche ist ${doc.status} – Aktion nicht möglich`);
  }

  async cancel(id: string): Promise<void> {
    const doc = await this.load(id);
    if (doc.status === 'running') {
      await this.store.patch(id, { cancelRequested: true });
      this.live.abort(id);
      return;
    }
    if (doc.status !== 'queued' && doc.status !== 'paused') throw this.conflict(doc);
    await this.queue.remove(id);
    await this.store.patch(id, {
      status: doc.content ? 'done' : 'cancelled',
      cancelRequested: false,
      pauseRequested: false,
    });
  }

  async pause(id: string): Promise<void> {
    const doc = await this.load(id);
    if (doc.status === 'queued') {
      await this.queue.remove(id);
      await this.store.patch(id, { status: 'paused', pauseRequested: false });
      return;
    }
    if (doc.status !== 'running') throw this.conflict(doc);
    await this.store.patch(id, { pauseRequested: true });
    this.live.abort(id);
  }

  async resume(id: string): Promise<void> {
    const doc = await this.load(id);
    const partial = doc.tasks.some((t) => t.status === 'done') || doc.sourceList.some((s) => s.relevant);
    if (doc.status !== 'paused' && !(doc.status === 'failed' && partial)) throw this.conflict(doc);
    // Vertiefen bleibt Vertiefen (samt Frage), sonst würde der Runner neu recherchieren.
    await this.store.patch(id, {
      mode: doc.mode === 'deepen' ? 'deepen' : 'resume',
      status: 'queued',
      queuedAt: new Date(),
      error: null,
      cancelRequested: false,
      pauseRequested: false,
    });
    await this.queue.enqueue(id);
  }

  async retry(id: string): Promise<void> {
    const doc = await this.load(id);
    if (doc.status !== 'failed' && doc.status !== 'cancelled') throw this.conflict(doc);
    await this.steps.removeFor(id);
    await this.store.patch(id, {
      tasks: [],
      sourceList: [],
      content: '',
      sources: [],
      followUps: [],
      roundsDone: 0,
      relatedKnowledge: [],
      files: doc.files.map((f) => ({ ...f, n: 0, notes: '' })),
      mode: 'research',
      modeQuestion: undefined,
      status: 'queued',
      queuedAt: new Date(),
      error: null,
      cancelRequested: false,
      pauseRequested: false,
    });
    await this.queue.enqueue(id);
  }

  async deepen(id: string, question: string): Promise<void> {
    const doc = await this.load(id);
    const q = question.trim();
    if (q.length < QUESTION_MIN || q.length > QUESTION_MAX) {
      throw new BadRequestException(`Frage braucht ${QUESTION_MIN} bis ${QUESTION_MAX} Zeichen`);
    }
    if (doc.status !== 'done' || !doc.content) throw this.conflict(doc);
    await this.store.patch(id, {
      followUps: [...doc.followUps, { question: q, at: new Date() }],
      mode: 'deepen',
      modeQuestion: q,
      status: 'queued',
      queuedAt: new Date(),
      error: null,
    });
    await this.queue.enqueue(id);
  }

  async move(id: string, target: { projectId?: string; customerId?: string }): Promise<void> {
    const doc = await this.load(id);
    if (doc.status !== 'done') throw this.conflict(doc);
    assertMoveTarget(RequestContext.getUser(), target);
    if (target.projectId) await this.projects.findById(target.projectId);
    else if (target.customerId) await this.customers.findById(target.customerId);
    const projectId = target.projectId ?? null;
    const customerId = target.customerId ?? null;
    await this.store.patch(id, { projectId, customerId });
    this.events.emit(PROJECT_CHANGED, {
      projectId,
      customerId,
      entity: 'research',
      action: 'created',
      entityId: id,
      summary: `Recherche "${doc.title}" zugeordnet`,
    });
  }

  async remove(id: string): Promise<void> {
    const doc = await this.load(id);
    if (doc.status === 'running') {
      await this.store.patch(id, { cancelRequested: true });
      this.live.abort(id);
    }
    await this.queue.remove(id);
    await this.steps.removeFor(id);
    await this.store.delete(id);
    if (isAssigned(doc)) {
      this.events.emit(PROJECT_CHANGED, {
        projectId: doc.projectId,
        customerId: doc.customerId,
        entity: 'research',
        action: 'deleted',
        entityId: id,
        summary: `Recherche "${doc.title}" gelöscht`,
      });
    }
  }

  async queuePositions(): Promise<Array<{ id: string; position: number }>> {
    const actor = RequestContext.getUser();
    const rows = await this.store.listActive(actor ? actor.userId : null);
    const rank = (d: RunDoc): number => (d.status === 'running' ? 0 : 1);
    const at = (d: RunDoc): number => d.queuedAt?.getTime() ?? 0;
    rows.sort((a, b) => rank(a) - rank(b) || at(a) - at(b) || a.id.localeCompare(b.id));
    return rows.map((d, i) => ({ id: d.id, position: i + 1 }));
  }
}
