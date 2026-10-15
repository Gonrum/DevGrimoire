import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KubeAuditAction =
  | 'connect' | 'list' | 'get' | 'logs' | 'metrics_query'
  | 'write' | 'exec' | 'terminal_open' | 'terminal_close';

export type KubeAuditSourceContext = 'ui' | 'mcp' | 'rest' | 'terminal' | 'dg';

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

  @Prop({ required: true, type: String, enum: ['ui', 'mcp', 'rest', 'terminal', 'dg'] })
  sourceContext: KubeAuditSourceContext;

  /**
   * Pflicht ausser bei `dg`: die Workspace-CLI hat keinen Nutzer, nur ein
   * projektgebundenes Token. Dort hält `workspaceId` fest, woher der Aufruf kam.
   *
   * Ein ausdrückliches `null` ist erlaubt: so speichert KubeAuditService den
   * Aufrufer `'system'` einer Instanz ohne Auth (keine ObjectId). Fehlt das
   * Feld dagegen ganz (`undefined`), greift die Pflicht weiterhin.
   */
  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required(this: KubeAudit) { return this.sourceContext !== 'dg' && this.userId !== null; },
  })
  userId?: Types.ObjectId | null;

  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required(this: KubeAudit) { return this.sourceContext === 'dg'; },
  })
  workspaceId?: Types.ObjectId;

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
