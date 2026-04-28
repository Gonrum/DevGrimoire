import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  async create(@Body() dto: CreateApiKeyDto, @Req() req: any) {
    const userId = req.user.userId;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { key, apiKey } = await this.apiKeysService.generate(
      userId,
      dto.name,
      expiresAt,
    );
    return {
      key,
      _id: apiKey._id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      expiresAt: apiKey.expiresAt,
      createdAt: (apiKey as any).createdAt,
    };
  }

  @Get()
  async list(@Req() req: any) {
    return this.apiKeysService.list(req.user.userId);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @Req() req: any,
  ) {
    return this.apiKeysService.update(id, req.user.userId, dto);
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: any) {
    await this.apiKeysService.revoke(id, req.user.userId);
    return { deleted: true };
  }
}
