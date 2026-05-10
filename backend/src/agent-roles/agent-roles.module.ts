import { Module } from '@nestjs/common';
import { AgentRolesController } from './agent-roles.controller';
import { AgentRolesService } from './agent-roles.service';

@Module({
  controllers: [AgentRolesController],
  providers: [AgentRolesService],
  exports: [AgentRolesService],
})
export class AgentRolesModule {}
