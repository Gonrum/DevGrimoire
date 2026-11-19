import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { PermissionGate } from '../auth/decorators/permission-gate.decorator';
import { SecretsService } from './secrets.service';
import { CreateSecretDto } from './dto/create-secret.dto';
import { UpdateSecretDto } from './dto/update-secret.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

// Writes here are checked against the precise catalog permission in the
// service (see `common/permissions.ts`), not by the generic entry gate.
@PermissionGate('service')
@Controller('secrets')
export class SecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Post()
  create(@Body(ValidateProjectIdPipe) dto: CreateSecretDto) {
    return this.secretsService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('environmentId') environmentId?: string,
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    return customerId
      ? this.secretsService.findByCustomer(customerId, environmentId)
      : this.secretsService.findByProject(projectId!, environmentId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.secretsService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSecretDto) {
    return this.secretsService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.secretsService.delete(id);
  }
}
