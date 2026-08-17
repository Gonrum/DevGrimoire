import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LlmUsageRecord, LlmUsageDocument } from './schemas/llm-usage.schema';

export interface UsageInput {
  purpose: string; endpointId: string; model: string;
  promptTokens: number; completionTokens: number; totalTokens: number;
  durationMs: number; status: 'ok' | 'error' | 'cancelled'; error?: string | null;
}

/** Ergebniszeile der `$group`-Aggregation in `summary()`. */
export interface UsagePerEndpoint {
  endpointId: string;
  totalTokens: number;
  errors: number;
  count: number;
}

@Injectable()
export class LlmUsageService {
  constructor(@InjectModel(LlmUsageRecord.name) private readonly model: Model<LlmUsageDocument>) {}

  async record(rec: UsageInput): Promise<void> {
    await this.model.create({ ...rec, ts: new Date(), error: rec.error ?? undefined });
  }

  async recent(limit = 50): Promise<LlmUsageDocument[]> {
    return this.model.find().sort({ ts: -1 }).limit(limit).exec();
  }

  async summary(): Promise<{ perEndpoint: UsagePerEndpoint[] }> {
    // Der Ergebnistyp einer Aggregation ist für Mongoose nicht ableitbar; das
    // Typargument ist der dafür vorgesehene Weg. Vorher lief das `any[]` der
    // Aggregation ungeprüft in den deklarierten Rückgabetyp.
    const perEndpoint = await this.model.aggregate<UsagePerEndpoint>([
      { $group: {
        _id: '$endpointId',
        totalTokens: { $sum: '$totalTokens' },
        errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        count: { $sum: 1 },
      } },
      { $project: { _id: 0, endpointId: '$_id', totalTokens: 1, errors: 1, count: 1 } },
    ]).exec();
    return { perEndpoint };
  }
}
