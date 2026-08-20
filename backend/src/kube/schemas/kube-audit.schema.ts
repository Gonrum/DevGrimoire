import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KubeAuditAction =
  | 'connect' | 'list' | 'get' | 'logs' | 'metrics_query'
  | 'write' | 'exec' | 'terminal_open' | 'terminal_close';

export type KubeAuditSourceContext = 'ui' | 'mcp' | 'rest' | 'terminal';

export type KubeAuditDocument = HydratedDocument<KubeAudit>;

@Schema({ collection: 'kubeaudits' })
export class KubeAudit {
  @Prop({ type: Types.ObjectId, ref: 'KubeCluster', required: true })
  clusterId: Types.ObjectId;

  @Prop({ required: true, default: () => new Date() })
  at: Date;

  @Prop({
    required: true,
    type: String,
    enum: ['connect', 'list', 'get', 'logs', 'metrics_query', 'write', 'exec', 'terminal_open', 'terminal_close'],
  })
  action: KubeAuditAction;

  @Prop({ required: true, type: String, enum: ['ui', 'mcp', 'rest', 'terminal'] })
  sourceContext: KubeAuditSourceContext;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AgentRole' })
  agentRoleId?: Types.ObjectId;

  @Prop()
  verb?: string;

  @Prop()
  resource?: string;

  @Prop()
  namespace?: string;

  @Prop()
  name?: string;

  @Prop()
  durationMs?: number;

  @Prop()
  errorMsg?: string;
}

export const KubeAuditSchema = SchemaFactory.createForClass(KubeAudit);

// 90-Tage-TTL wie bei sshaudits.
KubeAuditSchema.index({ at: 1 }, { expireAfterSeconds: 7_776_000 });
KubeAuditSchema.index({ clusterId: 1, at: -1 });
