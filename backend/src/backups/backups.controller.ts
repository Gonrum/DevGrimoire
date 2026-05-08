import { Controller, Get, Param, Post, Body, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { BackupsService } from './backups.service';
import { CreateBackupDto } from './dto/create-backup.dto';

@Controller('backups')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  @Post()
  create(@Body() dto: CreateBackupDto) {
    return this.backupsService.createManualBackup(dto);
  }

  @Get()
  findAll(@Query('limit') limit?: string) {
    return this.backupsService.findAll(limit ? Number(limit) : 50);
  }

  @Get('status')
  status() {
    return this.backupsService.getStatus();
  }

  @Get('retention/preview')
  previewRetention() {
    return this.backupsService.previewRetention();
  }

  @Post('retention/apply')
  applyRetention(@Body('confirm') confirm?: string) {
    return this.backupsService.applyRetention(confirm || '');
  }

  @Get(':id/restore-preview')
  previewRestore(@Param('id') id: string) {
    return this.backupsService.previewRestore(id);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.backupsService.findById(id);
  }
}
