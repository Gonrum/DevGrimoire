import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DocUpdateProposalDocument = HydratedDocument<DocUpdateProposal>;

export enum DocProposalStatus {
  OPEN = 'open',
  ACCEPTED = 'accepted',
  EDITED = 'edited',
  CONVERTED_TO_TODO = 'converted_to_todo',
  DISMISSED = 'dismissed',
  SUPERSEDED = 'superseded',
}

export enum DocProposalSourceType {
  TODO = 'todo',
  COMMIT = 'commit',
  RELEASE = 'release',
  WORKFLOW_RUN = 'workflow_run',
  MANUAL = 'manual',
}

export enum DocProposalTargetType {
  DOC_FILE = 'doc_file',
  KNOWLEDGE = 'knowledge',
  MANUAL = 'manual',
}

export enum DocProposalChangeMode {
  PATCH = 'patch',
  INSTRUCTIONS = 'instructions',
  NEW_SECTION = 'new_section',
  REVIEW_ONLY = 'review_only',
}

@Schema({ _id: false })
class DocProposalSource {
  @Prop({ required: true, enum: DocProposalSourceType })
  type: DocProposalSourceType;

  @Prop({ required: true })
  id: string;

  @Prop({ trim: true, maxlength: 300 })
  title?: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  summary: string;

  @Prop({ type: [String], default: [] })
  changedFiles: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];
}

@Schema({ _id: false })
class DocProposalTarget {
  @Prop({ required: true, enum: DocProposalTargetType })
  type: DocProposalTargetType;

  @Prop({ type: Types.ObjectId })
  id?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  path?: string;

  @Prop({ required: true, trim: true, maxlength: 300 })
  title: string;
}

@Schema({ _id: false })
class DocProposalSuggestedChange {
  @Prop({ required: true, enum: DocProposalChangeMode })
  mode: DocProposalChangeMode;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  summary: string;

  @Prop({ trim: true, maxlength: 8000 })
  diff?: string;

  @Prop({ trim: true, maxlength: 8000 })
  instructions?: string;
}

@Schema({ _id: false })
class DocProposalSafety {
  @Prop({ default: false })
  containsSecretValues: boolean;

  @Prop({ default: true })
  requiresHumanReview: boolean;

  @Prop({ default: false })
  destructive: boolean;
}

@Schema({ timestamps: true, collection: 'docupdateproposals' })
export class DocUpdateProposal {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, enum: DocProposalStatus, default: DocProposalStatus.OPEN, index: true })
  status: DocProposalStatus;

  @Prop({ type: DocProposalSource, required: true })
  source: DocProposalSource;

  @Prop({ type: DocProposalTarget, required: true })
  target: DocProposalTarget;

  @Prop({ required: true, trim: true, maxlength: 1000 })
  reason: string;

  @Prop({ required: true, min: 0, max: 10 })
  confidence: number;

  @Prop({ type: DocProposalSuggestedChange, required: true })
  suggestedChange: DocProposalSuggestedChange;

  @Prop({ type: DocProposalSafety, default: () => ({}) })
  safety: DocProposalSafety;

  @Prop({ type: String, enum: ['system', 'agent', 'user'], default: 'system' })
  createdBy: 'system' | 'agent' | 'user';

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  createdAt?: Date;
  updatedAt?: Date;
}

export const DocUpdateProposalSchema = SchemaFactory.createForClass(DocUpdateProposal);

DocUpdateProposalSchema.index({ projectId: 1, status: 1, createdAt: -1 });
DocUpdateProposalSchema.index({ projectId: 1, 'source.type': 1, 'source.id': 1 });
DocUpdateProposalSchema.index({ projectId: 1, 'target.type': 1, 'target.id': 1 });
