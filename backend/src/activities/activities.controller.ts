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
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const max = Math.min(limit ? parseInt(limit, 10) : 100, 200);
    return projectId
      ? this.activitiesService.findByProject(projectId, max)
      : this.activitiesService.findByCustomer(customerId!, max);
  }
}
