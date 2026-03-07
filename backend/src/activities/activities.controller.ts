import { Controller, Get, Query } from '@nestjs/common';
import { ActivitiesService } from './activities.service';

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    return this.activitiesService.findByProject(
      projectId,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
