import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SshAuditAction =
  | 'connect'
  | 'exec'
  | 'upload'
  | 'download'
  | 'list_files'
  | 'terminal_open'
  | 'terminal_close';

export type SshAuditSourceContext = 'terminal' | 'mcp' | 'rest';

export type SshAuditDocument = HydratedDocument<SshAudit>;

@Schema({ collection: 'sshaudits' })
export class SshAudit {
  @Prop({ type: Types.ObjectId, ref: 'SshConnection', required: true })
  connectionId: Types.ObjectId;

  @Prop({ required: true, default: () => new Date() })
  at: Date;

  @Prop({
    required: true,
    type: String,
    enum: [
      'connect',
      'exec',
      'upload',
      'download',
      'list_files',
      'terminal_open',
      'terminal_close',
    ],
  })
  action: SshAuditAction;

  @Prop({
    required: true,
    type: String,
    enum: ['terminal', 'mcp', 'rest'],
  })
  sourceContext: SshAuditSourceContext;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AgentRole' })
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
}

export const SshAuditSchema = SchemaFactory.createForClass(SshAudit);

// 90-day TTL on `at` (7_776_000 seconds).
SshAuditSchema.index({ at: 1 }, { expireAfterSeconds: 7_776_000 });

// Audit-tab listing ordered newest-first per connection.
SshAuditSchema.index({ connectionId: 1, at: -1 });
