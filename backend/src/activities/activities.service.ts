import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Activity, ActivityDocument } from './schemas/activity.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { projectIdFilter } from '../common/project-id-filter';

@Injectable()
export class ActivitiesService {
  constructor(
    @InjectModel(Activity.name) private activityModel: Model<ActivityDocument>,
  ) {}

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent) {
    const user = RequestContext.getUser();
    await this.activityModel.create({
      projectId: event.projectId || undefined,
      customerId: event.customerId || undefined,
      entity: event.entity,
      action: event.action,
      entityId: event.entityId,
      summary: event.summary,
      userId: user?.userId,
      username: user?.username,
    });
  }

  async findByProject(projectId: string, limit = 50): Promise<Activity[]> {
    return this.activityModel
      .find({ projectId: projectIdFilter(projectId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async findByCustomer(customerId: string, limit = 50): Promise<Activity[]> {
    return this.activityModel
      .find({ customerId: projectIdFilter(customerId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.activityModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.activityModel.deleteMany({ customerId }).exec();
  }
}
