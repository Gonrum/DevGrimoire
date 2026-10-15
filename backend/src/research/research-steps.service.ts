import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { errorMessage } from '../common/narrow';
import { ResearchStep, ResearchStepDocument } from './schemas/research-step.schema';
import type { StepKind } from './research-types';

@Injectable()
export class ResearchStepsService {
  private readonly logger = new Logger(ResearchStepsService.name);
  constructor(@InjectModel(ResearchStep.name) private readonly model: Model<ResearchStepDocument>) {}

  /** Wirft nie: ein fehlender Protokollschritt darf keinen Lauf abbrechen. */
  async record(researchId: string, step: { kind: StepKind; text: string; lane?: string }): Promise<void> {
    try {
      await this.model.create({ researchId: new Types.ObjectId(researchId), kind: step.kind, text: step.text.slice(0, 2000), lane: step.lane });
    } catch (err) {
      this.logger.warn(`Schritt nicht gespeichert: ${errorMessage(err)}`);
    }
  }

  async list(researchId: string, limit = 500) {
    if (!Types.ObjectId.isValid(researchId)) return [];
    return this.model.find({ researchId: new Types.ObjectId(researchId) })
      .sort({ at: 1 }).limit(Math.min(limit, 2000)).lean().exec();
  }

  async removeFor(researchId: string): Promise<void> {
    if (!Types.ObjectId.isValid(researchId)) return;
    await this.model.deleteMany({ researchId: new Types.ObjectId(researchId) }).exec();
  }
}
