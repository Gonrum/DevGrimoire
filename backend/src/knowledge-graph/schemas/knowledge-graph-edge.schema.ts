import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KnowledgeGraphEdgeDocument = HydratedDocument<KnowledgeGraphEdge>;

export const KG_ENTITY_TYPES = [
  'todo',
  'milestone',
  'knowledge',
  'manual',
  'research',
  'schema',
  'feature',
  'dependency',
  'changelog',
  'workflow',
  'release',
  'snippet',
  'commit',
  'validation_report',
  'doc_update_proposal',
  'session',
] as const;
export type KgEntityType = (typeof KG_ENTITY_TYPES)[number];

export const KG_RELATIONS = [
  'belongs_to',          // todo → milestone, milestone → project
  'completed_by',        // milestone → changelog
  'blocked_by',          // todo → todo
  'tagged_overlap',      // todo ↔ knowledge by shared tags
  'category_match',      // todo ↔ manual by category-tag match
  'validates',           // validation_report → todo
  'documents',           // manual/knowledge → todo (reverse of tagged_overlap/category_match for clarity)
  'depends_on',          // feature → feature, todo → feature
  'mentions',            // commit → todo (T-N pattern), session → todo
  'proposes_update',     // doc_update_proposal → manual/knowledge
  'references',          // generic
] as const;
export type KgRelation = (typeof KG_RELATIONS)[number];

@Schema({ _id: false })
class KgEndpoint {
  @Prop({ required: true, enum: KG_ENTITY_TYPES })
  entityType: KgEntityType;

  @Prop({ required: true })
  entityId: string;

  @Prop({ trim: true, maxlength: 300 })
  label?: string;
}

@Schema({ timestamps: true, collection: 'knowledgegraphedges' })
export class KnowledgeGraphEdge {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ type: KgEndpoint, required: true })
  source: KgEndpoint;

  @Prop({ type: KgEndpoint, required: true })
  target: KgEndpoint;

  @Prop({ required: true, enum: KG_RELATIONS })
  relation: KgRelation;

  @Prop({ default: 1, min: 0, max: 10 })
  weight: number;

  @Prop({ default: 1, min: 0, max: 1 })
  confidence: number;

  @Prop({ enum: ['directed', 'undirected'], default: 'directed' })
  direction: 'directed' | 'undirected';

  @Prop({ enum: ['system', 'agent', 'user'], default: 'system' })
  createdBy: 'system' | 'agent' | 'user';

  @Prop({ default: false })
  userConfirmed: boolean;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  createdAt?: Date;
  updatedAt?: Date;
}

export const KnowledgeGraphEdgeSchema = SchemaFactory.createForClass(KnowledgeGraphEdge);

KnowledgeGraphEdgeSchema.index({ projectId: 1, 'source.entityType': 1, 'source.entityId': 1 });
KnowledgeGraphEdgeSchema.index({ projectId: 1, 'target.entityType': 1, 'target.entityId': 1 });
KnowledgeGraphEdgeSchema.index({ projectId: 1, relation: 1 });
// Prevent exact duplicates (same projectId, endpoints, relation)
KnowledgeGraphEdgeSchema.index(
  {
    projectId: 1,
    'source.entityType': 1,
    'source.entityId': 1,
    'target.entityType': 1,
    'target.entityId': 1,
    relation: 1,
  },
  { unique: true },
);
