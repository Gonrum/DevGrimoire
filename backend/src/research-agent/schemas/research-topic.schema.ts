import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ResearchTopicDocument = HydratedDocument<ResearchTopic>;

/**
 * Reused verbatim from `RecurringFrequency` (recurring-tasks module) but kept
 * as an independent enum here — the research-agent module is deliberately
 * decoupled from recurring-tasks (see design spec, "Pre-flight decisions").
 */
export enum ResearchFrequency {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

export interface ResearchScope {
  mode: 'all' | 'selected';
  projectIds: Types.ObjectId[];
  customerIds: Types.ObjectId[];
  includeGlobal: boolean;
}

export interface ResearchWebSearchConfig {
  enabled: boolean;
  provider?: string;
}

export interface ResearchSchedule {
  frequency: ResearchFrequency;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  active: boolean;
  nextRun?: Date;
  lastRun?: Date;
  lastRunStatus?: string;
}

export interface ResearchGuardrails {
  maxIterations: number;
  maxWebSearches: number;
  maxWebFetches: number;
  timeoutMs: number;
}

/** Guardrail defaults applied to new topics unless explicitly overridden. */
export const DEFAULT_GUARDRAILS: ResearchGuardrails = {
  maxIterations: 12,
  maxWebSearches: 6,
  maxWebFetches: 8,
  timeoutMs: 300000,
};

@Schema({ timestamps: true })
export class ResearchTopic {
  // Assigned by the service layer (Task 8) via the existing 'research' counter
  // entity — intentionally left without a default/required here.
  @Prop()
  number: number;

  @Prop()
  displayNumber: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  brief: string;

  // This Mongoose-level default only fires if `scope` is omitted entirely
  // from the document passed to `.create()` — in practice unreachable, since
  // `ResearchTopicService.create`/`.update()` always compute and pass an
  // explicit `scope` via `buildScope()`, which is the AUTHORITATIVE
  // normalization (mode-dependent `includeGlobal` default — final-review
  // fix F1). Kept in sync with `buildScope`'s `mode: 'all'` case (where
  // `includeGlobal: true` is the correct default) purely as a safety net.
  @Prop({
    type: Object,
    default: (): ResearchScope => ({
      mode: 'all',
      projectIds: [],
      customerIds: [],
      includeGlobal: true,
    }),
  })
  scope: ResearchScope;

  @Prop({
    type: Object,
    default: (): ResearchWebSearchConfig => ({ enabled: false }),
  })
  webSearch: ResearchWebSearchConfig;

  @Prop({ type: Object, required: true })
  schedule: ResearchSchedule;

  @Prop({
    type: Object,
    default: (): ResearchGuardrails => ({ ...DEFAULT_GUARDRAILS }),
  })
  guardrails: ResearchGuardrails;

  // Run context (rights/scope for the background agent run).
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: Types.ObjectId;

  @Prop({ default: false })
  notifyOnComplete: boolean;
}

export const ResearchTopicSchema = SchemaFactory.createForClass(ResearchTopic);
ResearchTopicSchema.index({ 'schedule.active': 1, 'schedule.nextRun': 1 });
ResearchTopicSchema.index({ number: 1 }, { unique: true });
