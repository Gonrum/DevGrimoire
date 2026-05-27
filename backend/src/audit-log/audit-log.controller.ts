import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';

@Controller('audit-log')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  async list(
    @Query('action') action?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('actorType') actorType?: 'user' | 'apikey' | 'system',
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.auditLogService.findAll({
      action,
      actionPrefix,
      actorUserId,
      actorType,
      entityType,
      entityId,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  // T-339: JSON export with 10k cap — same filters as list(). Frontend
  // serialises the response to a downloadable file.
  @Get('export')
  async exportAll(
    @Query('action') action?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('actorType') actorType?: 'user' | 'apikey' | 'system',
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    return this.auditLogService.exportAll({
      action,
      actionPrefix,
      actorUserId,
      actorType,
      entityType,
      entityId,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
    });
  }

  @Get('actions')
  async distinctActions() {
    return this.auditLogService.distinctActions();
  }
}
