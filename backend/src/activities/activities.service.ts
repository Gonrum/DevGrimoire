import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Activity, ActivityDocument } from './schemas/activity.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { projectIdFilter } from '../common/project-id-filter';
import { assertCustomerInScope, assertProjectInScope, scopeFilter } from '../common/scope-guard';
import { assertSafeCascadeId } from '../common/cascade-guard';

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
    // An explicit foreign projectId used to return that project's activity feed.
    assertProjectInScope(projectId);
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    // Relation rows (project + customer) also need the customer axis.
    Object.assign(filter, scopeFilter());
    if (typeof entityType === 'string' && entityType) filter['entity'] = entityType;
    if (typeof entityId === 'string' && entityId) filter['entityId'] = entityId;
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
    assertCustomerInScope(customerId);
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    Object.assign(filter, scopeFilter());
    if (typeof entityType === 'string' && entityType) filter['entity'] = entityType;
    if (typeof entityId === 'string' && entityId) filter['entityId'] = entityId;
    return this.activityModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  /**
   * T-335: global dashboard feed without a fixed projectId/customerId.
   *
   * The scope filter runs in the query (both axes, AND): the previous
   * in-memory filter let a relation row through when only ONE axis was
   * accessible. Rows with neither axis (system events) stay visible.
   */
  async findAllVisible(
    limit = 50,
    entityType?: string,
    entityId?: string,
  ): Promise<Activity[]> {
    const filter: Record<string, unknown> = {};
    if (typeof entityType === 'string' && entityType) filter['entity'] = entityType;
    if (typeof entityId === 'string' && entityId) filter['entityId'] = entityId;
    Object.assign(filter, scopeFilter());
    return this.activityModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.activityModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.activityModel.deleteMany({ customerId }).exec();
  }
}
