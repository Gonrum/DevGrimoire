import { Controller, Get, Param } from '@nestjs/common';
import { AgentRolesService } from './agent-roles.service';

@Controller('agent-roles')
export class AgentRolesController {
  constructor(private readonly service: AgentRolesService) {}

  @Get()
  list() {
    return this.service.findAll();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.findById(id);
  }
}
