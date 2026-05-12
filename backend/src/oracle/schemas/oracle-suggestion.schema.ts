import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { KG_ENTITY_TYPES, KgEntityType } from '../../knowledge-graph/schemas/knowledge-graph-edge.schema';

export type OracleSuggestionDocument = HydratedDocument<OracleSuggestion>;

export enum OracleRiskType {
  STAGNATION = 'stagnation',
  DEADLINE_PRESSURE = 'deadline_pressure',
  BUG_HOTSPOT = 'bug_hotspot',
  BLOCKER_CHAIN = 'blocker_chain',
}

export enum OracleSeverity {
  INFO = 'info',
  WARN = 'warn',
  CRITICAL = 'critical',
}

export enum OracleSuggestionStatus {
  OPEN = 'open',
  DISMISSED = 'dismissed',
  CONVERTED_TO_TODO = 'converted_to_todo',
  ADDRESSED = 'addressed',
}

@Schema({ _id: false })
class OracleAffectedEntity {
  @Prop({ required: true, enum: KG_ENTITY_TYPES })
  entityType: KgEntityType;

  @Prop({ required: true })
  entityId: string;

  @Prop({ trim: true, maxlength: 300 })
  label?: string;
}

@Schema({ timestamps: true, collection: 'oraclesuggestions' })
export class OracleSuggestion {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, enum: OracleRiskType, index: true })
  type: OracleRiskType;

  @Prop({ required: true, enum: OracleSeverity, index: true })
  severity: OracleSeverity;

  @Prop({ required: true, enum: OracleSuggestionStatus, default: OracleSuggestionStatus.OPEN, index: true })
  status: OracleSuggestionStatus;

  @Prop({ required: true, trim: true, maxlength: 240 })
  title: string;

  @Prop({ required: true, trim: true, maxlength: 4000 })
  reason: string;

  @Prop({ trim: true, maxlength: 2000 })
  recommendedAction?: string;

  @Prop({ type: [OracleAffectedEntity], default: [] })
  affectedEntities: OracleAffectedEntity[];

  /**
   * Stable hash to dedup the same risk across analysis runs.
   * Format: type|projectId|sortedEntityKeys
   */
  @Prop({ required: true, index: true })
  fingerprint: string;

  @Prop()
  expiresAt?: Date;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OracleSuggestionSchema = SchemaFactory.createForClass(OracleSuggestion);
OracleSuggestionSchema.index({ projectId: 1, status: 1, severity: 1, createdAt: -1 });
OracleSuggestionSchema.index(
  { projectId: 1, fingerprint: 1 },
  { unique: true },
);
