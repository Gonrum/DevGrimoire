import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import type { AuthRequest } from '../common/request-context';

/**
 * Alle Routen hier sind nicht `@Public()`, der `JwtAuthGuard` hat also einen
 * Actor angehängt — deshalb `AuthRequest` (kanonische Fassung aus
 * `common/request-context`) statt einer eigenen `{ user?: { userId?: string } }`
 * -Deklaration.
 *
 * `req.user!.userId` behält das bisherige Laufzeitverhalten exakt: fehlt der
 * Actor (nur möglich, wenn Authentifizierung komplett deaktiviert ist — dann
 * lässt der Guard ohne `user` durch), lief der Zugriff schon vorher in einen
 * TypeError → HTTP 500. Wichtig ist, dass kein `undefined` als `userId` in die
 * Queries gelangt: `list`, `update` und `revoke` filtern darüber, und Mongoose
 * würde ein `userId: undefined` aus dem Filter *entfernen* — `list()` würde
 * dann die Keys **aller** Nutzer liefern und `revoke()` fremde Keys löschen.
 * Der Fehlschlag vor der Query ist also die sichere Variante und bleibt.
 */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  async create(@Body() dto: CreateApiKeyDto, @Req() req: AuthRequest) {
    const userId = req.user!.userId;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { key, apiKey } = await this.apiKeysService.generate(
      userId,
      dto.name,
      expiresAt,
      {
        allowedTools: dto.allowedTools,
        permissions: dto.permissions,
        projectScopeMode: dto.projectScopeMode,
        allowedProjectIds: dto.allowedProjectIds,
        customerScopeMode: dto.customerScopeMode,
        allowedCustomerIds: dto.allowedCustomerIds,
      },
    );
    return {
      key,
      _id: apiKey._id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      allowedTools: apiKey.allowedTools,
      permissions: apiKey.permissions,
      projectScopeMode: apiKey.projectScopeMode,
      allowedProjectIds: apiKey.allowedProjectIds,
      customerScopeMode: apiKey.customerScopeMode,
      allowedCustomerIds: apiKey.allowedCustomerIds,
    };
  }

  @Get()
  async list(@Req() req: AuthRequest) {
    return this.apiKeysService.list(req.user!.userId);
  }

  // T-337: admin-only "all keys + ownerUsername" view for the Settings table.
  @Get('all')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async listAll() {
    return this.apiKeysService.findAllWithOwners();
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @Req() req: AuthRequest,
  ) {
    return this.apiKeysService.update(id, req.user!.userId, dto);
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: AuthRequest) {
    await this.apiKeysService.revoke(id, req.user!.userId);
    return { deleted: true };
  }
}
