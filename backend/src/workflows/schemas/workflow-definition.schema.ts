import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WorkflowDefinitionDocument = WorkflowDefinition & Document;

export enum WorkflowScope {
  SYSTEM = 'system',
  PROJECT = 'project',
  CUSTOMER = 'customer',
}

export enum WorkflowStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
  ARCHIVED = 'archived',
}

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

@Schema({ _id: false })
export class WorkflowNode {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  type: string;

  @Prop()
  label?: string;

  @Prop({ type: Object, required: true })
  position: WorkflowNodePosition;

  @Prop({ type: Object, default: {} })
  config: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  secretRefs: string[];

  @Prop({ type: Object })
  inputs?: Record<string, unknown>;

  @Prop({ type: Object })
  outputs?: Record<string, unknown>;

  @Prop({ type: Object })
  ui?: Record<string, unknown>;
}

export const WorkflowNodeSchema = SchemaFactory.createForClass(WorkflowNode);

@Schema({ _id: false })
export class WorkflowEdge {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  source: string;

  @Prop({ required: true })
  target: string;

  @Prop()
  sourcePort?: string;

  @Prop()
  targetPort?: string;

  @Prop({ enum: ['success', 'failure', 'always', 'custom'] })
  branch?: string;

  @Prop({ type: Object })
  condition?: Record<string, unknown>;

  @Prop()
  label?: string;

  @Prop({ type: Object })
  ui?: Record<string, unknown>;
}

export const WorkflowEdgeSchema = SchemaFactory.createForClass(WorkflowEdge);

@Schema({ timestamps: true })
export class WorkflowDefinition {
  @Prop({ required: true, enum: WorkflowScope, index: true })
  scope: WorkflowScope;

  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ enum: WorkflowStatus, default: WorkflowStatus.DRAFT, index: true })
  status: WorkflowStatus;

  @Prop({ default: 1, min: 1 })
  version: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object, default: { type: 'manual' } })
  trigger: Record<string, unknown>;

  @Prop({ type: [WorkflowNodeSchema], default: [] })
  nodes: WorkflowNode[];

  @Prop({ type: [WorkflowEdgeSchema], default: [] })
  edges: WorkflowEdge[];

  @Prop({ type: Object })
  ui?: Record<string, unknown>;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedByUserId?: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const WorkflowDefinitionSchema = SchemaFactory.createForClass(WorkflowDefinition);

WorkflowDefinitionSchema.index({ scope: 1, projectId: 1, customerId: 1, status: 1, updatedAt: -1 });
WorkflowDefinitionSchema.index({ tags: 1 });
WorkflowDefinitionSchema.index({ name: 'text', description: 'text' });
