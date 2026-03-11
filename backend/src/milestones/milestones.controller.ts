import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { MilestonesService } from './milestones.service';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { MilestoneStatus } from './schemas/milestone.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('milestones')
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateMilestoneDto) {
    return this.milestonesService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('status') status?: MilestoneStatus,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.milestonesService.findByProject(projectId, status, includeArchived === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.milestonesService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMilestoneDto) {
    return this.milestonesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.milestonesService.remove(id);
  }
}
