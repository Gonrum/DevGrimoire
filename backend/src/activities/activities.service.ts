import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Activity, ActivityDocument } from './schemas/activity.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { projectIdFilter } from '../common/project-id-filter';
import { actorCanAccessProject, actorCanAccessCustomer } from '../common/permissions';

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

  async findByProject(
    projectId: string,
    limit = 50,
    entityType?: string,
    entityId?: string,
  ): Promise<Activity[]> {
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (entityType) filter['entity'] = entityType;
    if (entityId) filter['entityId'] = entityId;
    return this.activityModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async findByCustomer(
    customerId: string,
    limit = 50,
    entityType?: string,
    entityId?: string,
  ): Promise<Activity[]> {
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    if (entityType) filter['entity'] = entityType;
    if (entityId) filter['entityId'] = entityId;
    return this.activityModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  /**
   * T-335: global dashboard feed. Queries without a fixed projectId/customerId
   * and filters per-row by what the calling actor can see. Oversamples by 3x
   * before the in-memory filter so we still hit `limit` results even when
   * many rows belong to inaccessible scopes.
   */
  async findAllVisible(
    limit = 50,
    entityType?: string,
    entityId?: string,
  ): Promise<Activity[]> {
    const actor = RequestContext.getUser();
    const filter: Record<string, unknown> = {};
    if (entityType) filter['entity'] = entityType;
    if (entityId) filter['entityId'] = entityId;

    const oversample = Math.min(limit * 3, 500);
    const candidates = await this.activityModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(oversample)
      .lean()
      .exec();

    const visible: Activity[] = [];
    for (const doc of candidates) {
      // Global event with neither projectId nor customerId — assume visible
      // to anyone authenticated. Examples: notification rows, system events.
      if (!doc.projectId && !doc.customerId) {
        visible.push(doc);
      } else if (doc.projectId && actorCanAccessProject(actor, String(doc.projectId))) {
        visible.push(doc);
      } else if (doc.customerId && actorCanAccessCustomer(actor, String(doc.customerId))) {
        visible.push(doc);
      }
      if (visible.length >= limit) break;
    }
    return visible;
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.activityModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.activityModel.deleteMany({ customerId }).exec();
  }
}
