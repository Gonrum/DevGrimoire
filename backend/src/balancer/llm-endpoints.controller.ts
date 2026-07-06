import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmEndpointDto } from './dto/llm-endpoint.dto';

/**
 * Admin-managed registry of LLM backends for the balancer (T-… Phase 1).
 * Unlike chat/rag `config` (a single user-visible config doc with keys
 * masked), this is an internal routing registry — no non-admin caller needs
 * to read it, so every route is @Roles(UserRole.ADMIN), matching the
 * full-lockdown convention used for other admin registries (backups,
 * audit-log, users) rather than the read-open convention of chat/rag config.
 */
@Controller('llm-endpoints')
export class LlmEndpointsController {
  constructor(private readonly service: LlmEndpointsService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  list() { return this.service.list(); }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: LlmEndpointDto) { return this.service.create(dto); }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: LlmEndpointDto) { return this.service.update(id, dto); }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) { await this.service.remove(id); return { ok: true }; }

  @Post(':id/test')
  @Roles(UserRole.ADMIN)
  test(@Param('id') id: string) { return this.service.testConnection(id); }
}
