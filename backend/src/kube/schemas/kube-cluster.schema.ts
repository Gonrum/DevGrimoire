import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KubeTransport = 'direct' | 'ssh-tunnel';

@Schema({ _id: false })
export class KubeLastConnectError {
  @Prop({ required: true })
  at: Date;

  @Prop({ required: true })
  message: string;
}
export const KubeLastConnectErrorSchema = SchemaFactory.createForClass(KubeLastConnectError);

@Schema({ _id: false })
export class KubePrometheusConfig {
  @Prop({ required: true, default: false })
  enabled: boolean;

  @Prop({ trim: true })
  namespace?: string;

  @Prop({ trim: true })
  service?: string;

  @Prop({ min: 1, max: 65535 })
  port?: number;

  @Prop({ trim: true, default: '/' })
  path: string;
}
export const KubePrometheusConfigSchema = SchemaFactory.createForClass(KubePrometheusConfig);

export type KubeClusterDocument = HydratedDocument<KubeCluster>;

@Schema({ timestamps: true, collection: 'kubeclusters' })
export class KubeCluster {
  @Prop({ required: true, trim: true })
  label: string;

  @Prop({ required: true, trim: true })
  slug: string;

  // Genau eines von beiden — Pre-Save-Invariante unten.
  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  // FK -> Secret. Enthält die vollständige Kubeconfig, AES-256-GCM.
  @Prop({ type: Types.ObjectId, ref: 'Secret', required: true })
  kubeconfigSecretId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  contextName: string;

  // Denormalisiert aus der Kubeconfig, ausschliesslich zur Anzeige.
  @Prop({ required: true, trim: true })
  clusterServer: string;

  @Prop({ trim: true })
  defaultNamespace?: string;

  @Prop({ required: true, type: String, enum: ['direct', 'ssh-tunnel'], default: 'direct' })
  transport: KubeTransport;

  @Prop({ type: Types.ObjectId, ref: 'SshConnection' })
  sshConnectionId?: Types.ObjectId;

  // DevGrimoire-Ebene, nicht Cluster-RBAC. Siehe Spec, Abschnitt K3.
  @Prop({ required: true, default: true })
  readOnly: boolean;

  @Prop({ required: true, default: false })
  allowMcpWrites: boolean;

  @Prop({ required: true, default: false })
  allowInsecureTls: boolean;

  @Prop({ type: KubePrometheusConfigSchema, default: () => ({ enabled: false, path: '/' }) })
  prometheus: KubePrometheusConfig;

  @Prop()
  description?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  lastConnectedAt?: Date;

  @Prop({ type: KubeLastConnectErrorSchema })
  lastConnectError?: KubeLastConnectError;
}

export const KubeClusterSchema = SchemaFactory.createForClass(KubeCluster);

// Unique slug je Scope; die Partial-Filter halten leere Scopes auseinander.
KubeClusterSchema.index(
  { customerId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { customerId: { $exists: true } } },
);
KubeClusterSchema.index(
  { projectId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { projectId: { $exists: true } } },
);
KubeClusterSchema.index(
  { customerId: 1 },
  { partialFilterExpression: { customerId: { $exists: true } } },
);
KubeClusterSchema.index(
  { projectId: 1 },
  { partialFilterExpression: { projectId: { $exists: true } } },
);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

KubeClusterSchema.pre('validate', function (next) {
  const hasCustomer = Boolean(this.customerId);
  const hasProject = Boolean(this.projectId);
  if (hasCustomer === hasProject) {
    return next(new Error('scope: genau eines von customerId / projectId muss gesetzt sein'));
  }
  if (typeof this.slug !== 'string' || !SLUG_RE.test(this.slug) || this.slug.length < 3 || this.slug.length > 60) {
    return next(new Error('slug muss kebab-case sein (3-60 Zeichen, [a-z0-9-])'));
  }
  if (this.transport === 'ssh-tunnel' && !this.sshConnectionId) {
    return next(new Error('sshConnectionId ist bei transport="ssh-tunnel" erforderlich'));
  }
  if (this.allowMcpWrites && this.readOnly) {
    return next(new Error('allowMcpWrites setzt readOnly=false voraus'));
  }
  if (this.prometheus?.enabled) {
    const p = this.prometheus;
    if (!p.namespace || !p.service || !p.port) {
      return next(new Error('prometheus: namespace, service und port sind bei enabled=true erforderlich'));
    }
  }
  next();
});
