import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  HARNESS_MERGE_STRATEGIES,
  HARNESS_SCOPES,
  HARNESS_SECTION_KEY_PATTERN,
  HARNESS_SECTION_KINDS,
  HarnessMergeStrategy,
  HarnessScope,
} from '../harness.types';

@Schema({ _id: false })
export class HarnessSection {
  /** kebab-case; the join key when levels are merged. */
  @Prop({ required: true, match: HARNESS_SECTION_KEY_PATTERN })
  key: string;

  /**
   * Not restricted to HARNESS_SECTION_KINDS at the schema level on purpose: a
   * replicated document from a newer instance may carry a kind this build does
   * not know yet, and rejecting it would break replication instead of just
   * ignoring the section. Incoming API payloads are enum-checked in the DTO.
   */
  @Prop({ required: true, default: 'prose' })
  kind: string;

  /**
   * Not `required`: an empty title means "inherit the title from the level
   * below", which mongoose's required-validator would reject ('' fails it).
   */
  @Prop({ default: '' })
  title: string;

  @Prop({ default: '' })
  body: string;

  /** Structured payload for machine-readable kinds (constraints in H3). */
  @Prop({ type: Object })
  payload?: Record<string, unknown>;

  @Prop({ required: true, enum: HARNESS_MERGE_STRATEGIES, default: 'replace' })
  mergeStrategy: HarnessMergeStrategy;

  @Prop({ default: 0 })
  order: number;

  /** `false` on a lower level tombstones the inherited section. */
  @Prop({ default: true })
  enabled: boolean;
}

export const HarnessSectionSchema = SchemaFactory.createForClass(HarnessSection);

@Schema({ timestamps: true })
export class Harness {
  @Prop({ required: true, enum: HARNESS_SCOPES })
  scope: HarnessScope;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ maxlength: 500 })
  description?: string;

  /** `false` skips the whole level during resolution. */
  @Prop({ default: true })
  enabled: boolean;

  @Prop({ type: [HarnessSectionSchema], default: [] })
  sections: HarnessSection[];
}

export type HarnessDocument = HydratedDocument<Harness>;
export const HarnessSchema = SchemaFactory.createForClass(Harness);

/**
 * A harness is a singleton per level. Without these three indexes two
 * competing harnesses could sit on the same level and the merge order would be
 * undefined. Same partial-index pattern the Soul schema already uses.
 */
HarnessSchema.index({ projectId: 1 }, { unique: true, partialFilterExpression: { scope: 'project' } });
HarnessSchema.index(
  { customerId: 1 },
  { unique: true, partialFilterExpression: { scope: 'customer' } },
);
HarnessSchema.index({ scope: 1 }, { unique: true, partialFilterExpression: { scope: 'global' } });

/**
 * Duplicate keys within one harness would make the merge result depend on
 * array order alone — the resolver stays deterministic either way, but the data
 * is ambiguous, so it is rejected at write time.
 */
HarnessSchema.path('sections').validate(function (sections: HarnessSection[]) {
  if (!Array.isArray(sections)) return true;
  const keys = sections.map((section) => section.key);
  return new Set(keys).size === keys.length;
}, 'section keys must be unique within a harness');
