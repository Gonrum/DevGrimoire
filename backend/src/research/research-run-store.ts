import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Research, ResearchDocument, ResearchTask } from './schemas/research.schema';
import type { ResearchDepth, ResearchMode, ResearchStatus } from './research-types';
import type { RunFile } from './research-run-context';
import type { SourceEntry } from './research-sources';

export interface RunDoc {
  id: string;
  ownerUserId: string | null;
  projectId: string | null;
  customerId: string | null;
  title: string;
  focus?: string;
  depth: ResearchDepth;
  status: ResearchStatus;
  mode: ResearchMode;
  modeQuestion?: string;
  roundsDone: number;
  queuedAt?: Date;
  startedAt?: Date;
  totalMs: number;
  content: string;
  files: RunFile[];
  tasks: ResearchTask[];
  sourceList: SourceEntry[];
  followUps: Array<{ question: string; at: Date }>;
  model: string[];
  relatedKnowledge: Array<{ id: string; title: string; score: number }>;
  cancelRequested: boolean;
  pauseRequested: boolean;
}

export type RunPatch = Partial<Omit<RunDoc, 'id'>> & { error?: string | null; finishedAt?: Date; sources?: string[] };

type LeanResearch = Research & { _id: Types.ObjectId };

const ID_FIELDS = new Set(['ownerUserId', 'projectId', 'customerId']);

function idOrNull(id: Types.ObjectId | null | undefined): string | null {
  return id ? id.toString() : null;
}

function toRunDoc(d: LeanResearch): RunDoc {
  return {
    id: d._id.toString(),
    ownerUserId: idOrNull(d.ownerUserId),
    projectId: idOrNull(d.projectId),
    customerId: idOrNull(d.customerId),
    title: d.title,
    focus: d.focus,
    depth: d.depth ?? 'normal',
    status: d.status ?? 'done',
    mode: d.mode ?? 'research',
    modeQuestion: d.modeQuestion,
    roundsDone: d.roundsDone ?? 0,
    queuedAt: d.queuedAt,
    startedAt: d.startedAt,
    totalMs: d.totalMs ?? 0,
    content: d.content ?? '',
    files: (d.files ?? []).map((f) => ({ n: f.n, name: f.name, text: f.text, notes: f.notes ?? '' })),
    tasks: (d.tasks ?? []).map((t) => ({
      n: t.n, round: t.round, question: t.question, queries: [...(t.queries ?? [])], status: t.status,
      ...(t.summary !== undefined ? { summary: t.summary } : {}), sources: [...(t.sources ?? [])],
    })),
    sourceList: (d.sourceList ?? []).map((s) => ({
      n: s.n,
      ...(s.url !== undefined ? { url: s.url } : {}),
      ...(s.file !== undefined ? { file: s.file } : {}),
      title: s.title ?? '', notes: s.notes ?? '', relevant: s.relevant === true,
    })),
    followUps: (d.followUps ?? []).map((f) => ({ question: f.question, at: f.at })),
    model: [...(d.model ?? [])],
    relatedKnowledge: (d.relatedKnowledge ?? []).map((k) => ({ id: k.id, title: k.title, score: k.score })),
    cancelRequested: d.cancelRequested === true,
    pauseRequested: d.pauseRequested === true,
  };
}

/** Geprüfte ObjectId aus einer String-Id; ungültig → Fehler (nie ein ungeprüfter Wert im Filter). */
function oid(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw new Error(`ungültige Id: ${id}`);
  return new Types.ObjectId(id);
}

/** Einzige Stelle, an der der Runner mit Mongo spricht. */
@Injectable()
export class ResearchRunStore {
  constructor(@InjectModel(Research.name) private readonly model: Model<ResearchDocument>) {}

  async get(id: string): Promise<RunDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const d = await this.model.findById(oid(id)).lean<LeanResearch>().exec();
    return d ? toRunDoc(d) : null;
  }

  /** `undefined` → `$unset`, Id-Felder als ObjectId (oder null). */
  async patch(id: string, set: RunPatch): Promise<void> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(set)) {
      if (value === undefined) { $unset[key] = ''; continue; }
      if (ID_FIELDS.has(key)) {
        $set[key] = typeof value === 'string' ? oid(value) : null;
        continue;
      }
      $set[key] = value;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    if (Object.keys(update).length === 0) return;
    await this.model.updateOne({ _id: oid(id) }, update).exec();
  }

  /** Atomar `queued` → `running`; false, wenn das Dokument nicht mehr wartet. */
  async claimQueued(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await this.model.updateOne({ _id: oid(id), status: 'queued' }, { $set: { status: 'running' } }).exec();
    return res.modifiedCount === 1;
  }

  async countRunning(): Promise<number> {
    return this.model.countDocuments({ status: 'running' }).exec();
  }

  /** Gleicher Besitzer, wartend, früher eingereiht (Gleichstand: kleinere _id). */
  async olderQueuedExists(doc: RunDoc): Promise<boolean> {
    if (!Types.ObjectId.isValid(doc.id) || !(doc.queuedAt instanceof Date)) return false;
    if (doc.ownerUserId !== null && !Types.ObjectId.isValid(doc.ownerUserId)) return false;
    const owner = doc.ownerUserId === null ? null : oid(doc.ownerUserId);
    const found = await this.model.exists({
      ownerUserId: owner,
      status: 'queued',
      $or: [
        { queuedAt: { $lt: doc.queuedAt } },
        { queuedAt: doc.queuedAt, _id: { $lt: oid(doc.id) } },
      ],
    }).exec();
    return found !== null;
  }

  /** Neustart-Erholung: alle laufenden pausieren. */
  async pauseAllRunning(note: string): Promise<number> {
    const res = await this.model.updateMany(
      { status: 'running' },
      { $set: { status: 'paused', error: note, pauseRequested: false, cancelRequested: false } },
    ).exec();
    return res.modifiedCount;
  }
}
