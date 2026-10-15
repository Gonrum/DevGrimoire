import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ALL_SENSITIVITY_LEVELS, Sensitivity, SensitivityLevel } from '../../common/sensitivity';
import type { ResearchDepth, ResearchMode, ResearchStatus, TaskStatus } from '../research-types';

export type ResearchDocument = HydratedDocument<Research>;

@Schema({ _id: false })
export class ResearchSource {
  @Prop({ required: true }) n: number;
  @Prop() url?: string;
  @Prop() file?: string;
  @Prop({ default: '' }) title: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) relevant: boolean;
}
export const ResearchSourceSchema = SchemaFactory.createForClass(ResearchSource);

@Schema({ _id: false })
export class ResearchTask {
  @Prop({ required: true }) n: number;
  @Prop({ required: true }) round: number;
  @Prop({ required: true }) question: string;
  @Prop({ type: [String], default: [] }) queries: string[];
  @Prop({ type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' }) status: TaskStatus;
  @Prop() summary?: string;
  @Prop({ type: [Number], default: [] }) sources: number[];
}
export const ResearchTaskSchema = SchemaFactory.createForClass(ResearchTask);

@Schema({ _id: false })
export class ResearchFile {
  @Prop({ required: true }) n: number;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) text: string;
  @Prop({ default: '' }) notes: string;
}
export const ResearchFileSchema = SchemaFactory.createForClass(ResearchFile);

@Schema({ timestamps: true })
export class Research {
  // Besitzer einer persönlichen (nicht zugeordneten) Recherche. Alt-Einträge: null.
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  ownerUserId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  // Alt-Format (reine URLs); wird beim Abschluss eines Laufs mit den URLs der zitierten Quellen befüllt.
  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  // Data classification (T-219). confidential/personal/secret skip RAG.
  @Prop({ type: String, enum: ALL_SENSITIVITY_LEVELS, default: Sensitivity.INTERNAL })
  sensitivity: SensitivityLevel;

  @Prop() focus?: string;
  @Prop({ type: String, enum: ['quick', 'normal', 'thorough'], default: 'normal' }) depth: ResearchDepth;
  @Prop({ type: [ResearchFileSchema], default: [] }) files: ResearchFile[];

  // Default done: Alt-Einträge und research_save.
  @Prop({ type: String, enum: ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'], default: 'done', index: true })
  status: ResearchStatus;
  @Prop() queuedAt?: Date;
  @Prop() startedAt?: Date;
  @Prop() finishedAt?: Date;
  @Prop({ default: 0 }) totalMs: number;
  @Prop() error?: string;
  @Prop({ default: false }) cancelRequested: boolean;
  @Prop({ default: false }) pauseRequested: boolean;

  @Prop({ type: String, enum: ['research', 'deepen', 'resume'], default: 'research' }) mode: ResearchMode;
  @Prop() modeQuestion?: string;
  @Prop({ default: 0 }) roundsDone: number;
  @Prop({ type: [ResearchTaskSchema], default: [] }) tasks: ResearchTask[];
  @Prop({ type: [{ question: String, at: Date, _id: false }], default: [] }) followUps: Array<{ question: string; at: Date }>;

  @Prop({ type: [ResearchSourceSchema], default: [] }) sourceList: ResearchSource[];
  @Prop({ type: [String], default: [] }) model: string[];
  @Prop({ type: [{ id: String, title: String, score: Number, _id: false }], default: [] })
  relatedKnowledge: Array<{ id: string; title: string; score: number }>;
  // "project:<id>" | "customer:<id>" (Plan 2 nutzt es)
  @Prop() moveTargetHint?: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ResearchSchema = SchemaFactory.createForClass(Research);
ResearchSchema.index({ projectId: 1 });
ResearchSchema.index({ customerId: 1 });
ResearchSchema.index({ title: 'text', content: 'text', tags: 'text' });
ResearchSchema.index({ ownerUserId: 1, status: 1, queuedAt: 1 });
