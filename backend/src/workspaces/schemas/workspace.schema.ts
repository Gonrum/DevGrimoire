import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WorkspaceDocument = HydratedDocument<Workspace>;

export type WorkspaceStatus = 'active' | 'archived' | 'cleaning';

export const WORKSPACE_STATUSES: WorkspaceStatus[] = ['active', 'archived', 'cleaning'];

/**
 * Slug-style names: alphanumeric start, then alphanumerics/dash/underscore. Used
 * verbatim as a path segment under /workspaces/{name}/, so anything that could
 * escape the directory or break shell quoting is rejected here.
 */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

@Schema({ timestamps: true, collection: 'workspaces' })
export class Workspace {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, maxlength: 64 })
  name: string;

  @Prop({ maxlength: 500 })
  description?: string;

  @Prop()
  repoUrl?: string;

  @Prop({ default: 'main' })
  branch: string;

  @Prop({ required: true })
  path: string;

  @Prop({ required: true, enum: WORKSPACE_STATUSES, default: 'active' })
  status: WorkspaceStatus;

  @Prop({ default: 0 })
  sizeBytes: number;

  @Prop({ default: () => new Date() })
  lastActivityAt: Date;

  @Prop()
  createdBySessionId?: string;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
WorkspaceSchema.index({ projectId: 1, name: 1 }, { unique: true });
WorkspaceSchema.index({ projectId: 1, status: 1 });
WorkspaceSchema.index({ lastActivityAt: 1 });
