import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ActivitiesService } from './activities.service';

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  findAll(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('limit') limit?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
  ) {
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const max = Math.min(limit ? parseInt(limit, 10) : 100, 200);
    // T-335: no scope → global dashboard feed (per-row visibility filter).
    if (!projectId && !customerId) {
      return this.activitiesService.findAllVisible(max, entityType, entityId);
    }
    return projectId
      ? this.activitiesService.findByProject(projectId, max, entityType, entityId)
      : this.activitiesService.findByCustomer(customerId!, max, entityType, entityId);
  }
}
