import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { SecretsService } from './secrets.service';
import { CreateSecretDto } from './dto/create-secret.dto';
import { UpdateSecretDto } from './dto/update-secret.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('secrets')
export class SecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Post()
  create(@Body(ValidateProjectIdPipe) dto: CreateSecretDto) {
    return this.secretsService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId: string,
    @Query('environmentId') environmentId?: string,
  ) {
    return this.secretsService.findByProject(projectId, environmentId);
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
