import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { WorkflowScope } from './workflow-definition.schema';

export type WorkflowRunDocument = WorkflowRun & Document;

export type WorkflowRunMode = 'normal' | 'debug';

/** Zustand eines Debug-Laufs (`mode: 'debug'`). */
export interface WorkflowRunDebugState {
  /** Nodes, die als Nächstes drankommen dürfen; die erste Id ist der nächste Schritt. */
  pendingNodeIds: string[];
  /** Letzter Schritt bzw. Start — Grundlage für den Leerlauf-Abbruch. */
  lastActivityAt: Date;
  /** Hinweise an den Debuggenden, z. B. entfernte, übersprungene Nodes. */
  notices: string[];
}

export enum WorkflowRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  WAITING_FOR_USER = 'waiting_for_user',
  WAITING_FOR_TIMER = 'waiting_for_timer',
  /** Debug-Lauf: hält vor dem nächsten Node an, bis ein Schritt per REST kommt. */
  WAITING_FOR_STEP = 'waiting_for_step',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Schema({ timestamps: true })
export class WorkflowRun {
  @Prop({ type: Types.ObjectId, ref: 'WorkflowDefinition', required: true, index: true })
  definitionId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  definitionVersion: number;

  @Prop({ type: Object, required: true })
  definitionSnapshot: Record<string, unknown>;

  @Prop({ required: true, enum: WorkflowScope, index: true })
  scope: WorkflowScope;

  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ type: Object, required: true })
  trigger: Record<string, unknown>;

  @Prop({ enum: WorkflowRunStatus, default: WorkflowRunStatus.QUEUED, index: true })
  status: WorkflowRunStatus;

  @Prop({ type: [String], default: [] })
  currentNodeIds: string[];

  /**
   * `debug`: Schritt-für-Schritt-Lauf aus dem Editor. Nachfolger werden nicht
   * eingereiht, sondern in `debug.pendingNodeIds` gesammelt.
   */
  @Prop({ type: String, enum: ['normal', 'debug'], default: 'normal' })
  mode: WorkflowRunMode;

  // `default: undefined`: Mongoose legt Arrays sonst immer als `[]` an — und
  // jeder normale Lauf trüge ein leeres `debug`-Objekt.
  @Prop(
    raw({
      pendingNodeIds: { type: [String], default: undefined },
      lastActivityAt: { type: Date },
      notices: { type: [String], default: undefined },
    }),
  )
  debug?: WorkflowRunDebugState;

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ type: Object })
  error?: Record<string, unknown>;

  @Prop({ type: Object, default: () => ({ nodes: {} }) })
  context: Record<string, unknown>;

  @Prop({ type: Object })
  triggeredBy?: {
    type: 'manual' | 'schedule' | 'event';
    scheduleSlotAt?: Date;
    userId?: string;
    /**
     * Kam der Start über einen API-Key, dessen Id: der Lauf bekommt dann den
     * verengten Scope des Keys (Key ∩ Besitzer), nicht den vollen des Besitzers.
     */
    apiKeyId?: string;
  };

  /** Number of node executions performed by this run. Capped per security policy. */
  @Prop({ default: 0, min: 0 })
  executedNodeCount: number;

  /**
   * If this run is a retry, the originating run that produced it. The two
   * runs share `definitionId` and `definitionSnapshot`. The retry's status is
   * independent — the parent stays in its terminal status (FAILED/CANCELLED).
   */
  @Prop({ type: Types.ObjectId, ref: 'WorkflowRun', index: true })
  parentRunId?: Types.ObjectId;

  /** Optional: node id the retry started from (vs. resuming from the failed node). */
  @Prop()
  retryFromNodeId?: string;

  /**
   * Stamped atomically when a retry is initiated for this run. Used to prevent
   * a second concurrent retry-call from spawning a duplicate child run.
   * The field is set on the PARENT, not on the child.
   */
  @Prop({ type: Date })
  retryClaimedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const WorkflowRunSchema = SchemaFactory.createForClass(WorkflowRun);

WorkflowRunSchema.index({ definitionId: 1, createdAt: -1 });
WorkflowRunSchema.index({ scope: 1, projectId: 1, customerId: 1, status: 1, createdAt: -1 });
WorkflowRunSchema.index({ status: 1, updatedAt: 1 });
/**
 * Ein Lauf pro Zeitplan-Slot. Partiell statt `sparse`: bei einem
 * zusammengesetzten Index greift `sparse` nur, wenn *alle* Felder fehlen —
 * `definitionId` ist immer gesetzt, also zählte jeder manuelle Lauf als Slot
 * `null` und ab dem zweiten Start kam E11000. Neuer Name, damit der alte
 * Index beim Start entfernt werden kann (WorkflowsModule.onModuleInit).
 */
export const SCHEDULE_SLOT_INDEX = 'uniq_run_per_schedule_slot_v2';
export const LEGACY_SCHEDULE_SLOT_INDEX = 'uniq_run_per_schedule_slot';
WorkflowRunSchema.index(
  { definitionId: 1, 'triggeredBy.scheduleSlotAt': 1 },
  {
    unique: true,
    name: SCHEDULE_SLOT_INDEX,
    partialFilterExpression: { 'triggeredBy.scheduleSlotAt': { $type: 'date' } },
  },
);
