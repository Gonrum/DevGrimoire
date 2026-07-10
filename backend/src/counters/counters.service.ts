import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Counter, CounterDocument } from './schemas/counter.schema';

export interface CounterScope {
  projectId?: string;
  customerId?: string;
}

@Injectable()
export class CountersService {
  constructor(
    @InjectModel(Counter.name) private counterModel: Model<CounterDocument>,
  ) {}

  private scopeFilter(scope: CounterScope, allowEmpty = false): Record<string, unknown> {
    if (scope.projectId && scope.customerId) {
      throw new BadRequestException('Counter scope must be either projectId OR customerId, not both');
    }
    if (scope.projectId) {
      return { projectId: scope.projectId, customerId: null };
    }
    if (scope.customerId) {
      return { projectId: null, customerId: scope.customerId };
    }
    if (allowEmpty) {
      // Global counter (e.g. research topics span multiple projects).
      return { projectId: null, customerId: null };
    }
    throw new BadRequestException('Counter scope requires projectId or customerId');
  }

  async getNextSequence(
    scope: CounterScope | string,
    entity: 'todo' | 'milestone' | 'research',
  ): Promise<number> {
    const filter = typeof scope === 'string'
      ? { projectId: scope, customerId: null }
      : this.scopeFilter(scope, entity === 'research');
    const counter = await this.counterModel.findOneAndUpdate(
      { ...filter, entity },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).exec();
    return counter!.seq;
  }

  async setSequence(
    scope: CounterScope | string,
    entity: 'todo' | 'milestone' | 'research',
    seq: number,
  ): Promise<void> {
    const filter = typeof scope === 'string'
      ? { projectId: scope, customerId: null }
      : this.scopeFilter(scope, entity === 'research');
    await this.counterModel.findOneAndUpdate(
      { ...filter, entity },
      { $set: { seq } },
      { upsert: true },
    ).exec();
  }
}
