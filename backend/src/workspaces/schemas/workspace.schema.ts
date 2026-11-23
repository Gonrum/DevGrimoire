import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { AGENT_ALLOW_KINDS, AGENT_ALLOW_MATCHES, AgentAllowEntry } from '../agent-allow';

export type WorkspaceDocument = HydratedDocument<Workspace>;

export type WorkspaceStatus = 'active' | 'archived' | 'cleaning';

export const WORKSPACE_STATUSES: WorkspaceStatus[] = ['active', 'archived', 'cleaning'];

/** Where the working directory lives: sidecar container or a server over SSH. */
export type WorkspaceLocation = 'container' | 'ssh';

export const WORKSPACE_LOCATIONS: WorkspaceLocation[] = ['container', 'ssh'];

/** IDE agent: ask before each write/command (`confirm`) or run directly. */
export type WorkspaceAgentMode = 'confirm' | 'direct';

export const WORKSPACE_AGENT_MODES: WorkspaceAgentMode[] = ['confirm', 'direct'];

/**
 * Slug-style names: alphanumeric start, then alphanumerics/dash/underscore. Used
 * verbatim as a path segment under /workspaces/{name}/, so anything that could
 * escape the directory or break shell quoting is rejected here.
 */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

@Schema({ timestamps: true, collection: 'workspaces' })
export class Workspace {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Project', required: true, index: true })
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

  /** Documents without the field (legacy) count as `container`. */
  @Prop({ type: String, enum: WORKSPACE_LOCATIONS, default: 'container' })
  location: WorkspaceLocation;

  /** Only for `location: 'ssh'`; immutable after creation. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'SshConnection' })
  sshConnectionId?: Types.ObjectId;

  /** Only for `location: 'ssh'`: absolute, normalised; `path` mirrors it. */
  @Prop()
  remotePath?: string;

  /** Documents without the field (legacy) count as `confirm`. */
  @Prop({ type: String, enum: WORKSPACE_AGENT_MODES, default: 'confirm' })
  agentMode: WorkspaceAgentMode;

  /**
   * Container only: the IDE agent's ws_exec gets the workspace_exec env (git
   * tokens, DG_*) only when true. Legacy documents without the field: false.
   * SSH workspaces never get credentials.
   */
  @Prop({ type: Boolean, default: false })
  agentCredentials: boolean;

  /** "Always allow" rules of the IDE agent; at most 100, see agent-allow.ts. */
  @Prop({
    type: [
      {
        kind: { type: String, enum: AGENT_ALLOW_KINDS, required: true },
        match: { type: String, enum: AGENT_ALLOW_MATCHES },
        value: { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  agentAllow: AgentAllowEntry[];

  @Prop({ required: true, enum: WORKSPACE_STATUSES, default: 'active' })
  status: WorkspaceStatus;

  @Prop({ default: 0 })
  sizeBytes: number;

  @Prop({ default: () => new Date() })
  lastActivityAt: Date;

  @Prop()
  createdBySessionId?: string;

  /**
   * Optional reference to a `project.gitRepositories[]._id`. If set, the
   * workspace_exec env-injection uses this specific repo's token instead of
   * the per-provider first-wins default. Stored as a string (the embedded
   * subdoc id) so the resolver can match it without populating refs.
   */
  @Prop()
  gitRepoId?: string;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
WorkspaceSchema.index({ projectId: 1, name: 1 }, { unique: true });
WorkspaceSchema.index({ projectId: 1, status: 1 });
WorkspaceSchema.index({ lastActivityAt: 1 });
