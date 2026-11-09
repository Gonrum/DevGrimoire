import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import type { StepKind } from '../research-types';

/** Ein Protokollschritt einer Recherche. Eigene Collection statt Array am
 *  Dokument, damit lange Läufe das Dokument nicht unbegrenzt wachsen lassen. */
@Schema({ collection: 'researchsteps' })
export class ResearchStep {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true }) researchId: Types.ObjectId;
  @Prop({ type: String, required: true }) kind: StepKind;
  @Prop({ required: true }) text: string;
  @Prop() lane?: string;
  @Prop({ default: () => new Date() }) at: Date;
}
export type ResearchStepDocument = HydratedDocument<ResearchStep>;
export const ResearchStepSchema = SchemaFactory.createForClass(ResearchStep);
ResearchStepSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
