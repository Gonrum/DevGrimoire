import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WorkflowNodeRun,
  WorkflowNodeRunDocument,
  WorkflowNodeRunStatus,
} from '../schemas/workflow-node-run.schema';
import { WorkflowEngineService } from './workflow-engine.service';
import { errorMessage } from '../workflow-narrow';

@Injectable()
export class WorkflowDelayScheduler {
  private readonly logger = new Logger(WorkflowDelayScheduler.name);

  constructor(
    @InjectModel(WorkflowNodeRun.name)
    private readonly nodeRunModel: Model<WorkflowNodeRunDocument>,
    private readonly engine: WorkflowEngineService,
  ) {}

  @Cron('*/15 * * * * *')
  async tick(): Promise<void> {
    if (process.env.WORKFLOW_SCHEDULER_DISABLED === 'true') return;
    const due = await this.nodeRunModel
      .find({
        'waitingFor.type': 'delay',
        'waitingFor.resumeAt': { $lte: new Date() },
        status: WorkflowNodeRunStatus.WAITING,
      })
      .limit(50)
      .exec();
    for (const nr of due) {
      try {
        await this.engine.resumeDelayedNode(nr._id);
      } catch (err: unknown) {
        this.logger.warn(
          `resumeDelayedNode failed for ${nr._id.toString()}: ${errorMessage(err)}`,
        );
      }
    }
  }
}
