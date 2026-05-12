import { Body, Controller, Get, Put } from '@nestjs/common';
import { WorkflowAgentService } from './workflow-agent.service';
import { UpdateWorkflowAgentConfigDto, WorkflowAgentConfigPublic } from './dto/workflow-agent.dto';

@Controller('workflow-agent/config')
export class WorkflowAgentController {
  constructor(private readonly agent: WorkflowAgentService) {}

  @Get()
  async get(): Promise<WorkflowAgentConfigPublic | null> {
    return this.agent.getConfig();
  }

  @Put()
  async set(@Body() dto: UpdateWorkflowAgentConfigDto): Promise<WorkflowAgentConfigPublic | null> {
    await this.agent.setConfig(dto);
    return this.agent.getConfig();
  }
}
