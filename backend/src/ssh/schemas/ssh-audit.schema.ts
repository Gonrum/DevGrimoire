import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type SshAuditAction =
  | 'connect'
  | 'exec'
  | 'upload'
  | 'download'
  | 'list_files'
  | 'terminal_open'
  | 'terminal_close'
  // IDE file operations on an SSH workspace (path only, never content).
  | 'write'
  | 'mkdir'
  | 'move'
  | 'delete';

export const SSH_AUDIT_ACTIONS: readonly SshAuditAction[] = [
  'connect',
  'exec',
  'upload',
  'download',
  'list_files',
  'terminal_open',
  'terminal_close',
  'write',
  'mkdir',
  'move',
  'delete',
];

// 'dg': `dg scp` from a workspace terminal. The token carries no user, only
// the workspace — userId is omitted, workspaceId is required.
// 'ide': browser IDE on an SSH workspace — userId AND workspaceId are set.
export type SshAuditSourceContext = 'terminal' | 'mcp' | 'rest' | 'workflow' | 'dg' | 'ide';

export const SSH_AUDIT_SOURCE_CONTEXTS: readonly SshAuditSourceContext[] = [
  'terminal',
  'mcp',
  'rest',
  'workflow',
  'dg',
  'ide',
];

export type SshAuditDocument = HydratedDocument<SshAudit>;

@Schema({ collection: 'sshaudits' })
export class SshAudit {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'SshConnection', required: true })
  connectionId: Types.ObjectId;

  @Prop({ required: true, default: () => new Date() })
  at: Date;

  @Prop({
    required: true,
    type: String,
    enum: [...SSH_AUDIT_ACTIONS],
  })
  action: SshAuditAction;

  @Prop({
    required: true,
    type: String,
    enum: [...SSH_AUDIT_SOURCE_CONTEXTS],
  })
  sourceContext: SshAuditSourceContext;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'User',
    required(this: { sourceContext?: string }) { return this.sourceContext !== 'dg'; },
  })
  userId?: Types.ObjectId;

  /** With sourceContext='dg' or 'ide': the workspace the action came from. */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Workspace',
    required(this: { sourceContext?: string }) {
      return this.sourceContext === 'dg' || this.sourceContext === 'ide';
    },
  })
  workspaceId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'AgentRole' })
  agentRoleId?: Types.ObjectId;

  // For action='exec', truncated to 500 chars (enforced at write site).
  @Prop()
  command?: string;

  @Prop()
  remotePath?: string;

  @Prop()
  bytes?: number;

  @Prop()
  exitCode?: number;

  @Prop()
  durationMs?: number;

  @Prop()
  errorMsg?: string;

  // Nur bei sourceContext='workflow': aus welchem Lauf/Node der Befehl kam.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'WorkflowRun' })
  workflowRunId?: Types.ObjectId;

  @Prop()
  workflowNodeId?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'WorkflowDefinition' })
  workflowDefinitionId?: Types.ObjectId;

  // Nur gesetzt (true), wenn der Befehl aus einem Debug-Lauf kam.
  @Prop()
  workflowDebug?: boolean;

  // Only set (true) with sourceContext='ide' when the IDE agent caused the action.
  @Prop()
  agent?: boolean;
}

export const SshAuditSchema = SchemaFactory.createForClass(SshAudit);

// 90-day TTL on `at` (7_776_000 seconds).
SshAuditSchema.index({ at: 1 }, { expireAfterSeconds: 7_776_000 });

// Audit-tab listing ordered newest-first per connection.
SshAuditSchema.index({ connectionId: 1, at: -1 });
