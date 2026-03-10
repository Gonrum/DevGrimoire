import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Counter, CounterDocument } from './schemas/counter.schema';

@Injectable()
export class CountersService {
  constructor(
    @InjectModel(Counter.name) private counterModel: Model<CounterDocument>,
  ) {}

  async getNextSequence(
    projectId: string,
    entity: 'todo' | 'milestone',
  ): Promise<number> {
    const counter = await this.counterModel.findOneAndUpdate(
      { projectId, entity },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).exec();
    return counter!.seq;
  }

  async setSequence(
    projectId: string,
    entity: 'todo' | 'milestone',
    seq: number,
  ): Promise<void> {
    await this.counterModel.findOneAndUpdate(
      { projectId, entity },
      { $set: { seq } },
      { upsert: true },
    ).exec();
  }
}
