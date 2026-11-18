import { Body, Controller, Get, Put } from '@nestjs/common';
import { WorkflowAgentService } from './workflow-agent.service';
import { UpdateWorkflowAgentConfigDto, WorkflowAgentConfigPublic } from './dto/workflow-agent.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';

@Controller('workflow-agent/config')
export class WorkflowAgentController {
  constructor(private readonly agent: WorkflowAgentService) {}

  @Get()
  async get(): Promise<WorkflowAgentConfigPublic | null> {
    return this.agent.getConfig();
  }

  // Instance-wide: the endpoint URL and the tool switch apply to every
  // workflow in every project, so only admins may change them.
  @Put()
  @Roles(UserRole.ADMIN)
  async set(@Body() dto: UpdateWorkflowAgentConfigDto): Promise<WorkflowAgentConfigPublic | null> {
    await this.agent.setConfig(dto);
    return this.agent.getConfig();
  }
}
