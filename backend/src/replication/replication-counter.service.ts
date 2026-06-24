import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ReplicationCounter, ReplicationCounterDocument } from './schemas/replication-counter.schema';

const COUNTER_KEY = 'replication_log';

@Injectable()
export class ReplicationCounterService {
  constructor(
    @InjectModel(ReplicationCounter.name)
    private counterModel: Model<ReplicationCounterDocument>,
  ) {}

  /**
   * Atomically increment and return the next sequence. Single writer (the log
   * writer) → contention-free and gap-free. upsert seeds the doc on first call.
   */
  async nextSeq(): Promise<number> {
    const doc = await this.counterModel
      .findOneAndUpdate(
        { key: COUNTER_KEY },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      )
      .exec();
    return doc.seq;
  }
}
