import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { actorCanAccessProject } from '../common/permissions';
import { isRecord } from '../common/narrow';
import type { AuthRequest, RequestUser } from '../common/request-context';
import { OAuthDecisionDto } from './dto/oauth-decision.dto';
import { OAuthService } from './oauth.service';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { AdminPermission, PermissionGate } from '../auth/decorators/permission-gate.decorator';
import { Permission } from '../common/permissions';

/**
 * REST side of the MCP OAuth flow: the consent endpoint and "connected apps".
 * Not `@Public()` (except `info`): the global JWT guard authenticates the
 * logged-in user in the browser. API-key actors are refused — a key must
 * never be able to mint, list or revoke connections.
 */
@Controller('oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  /** The signed-in user (JWT only); everything else is 403. */
  private requireUser(req: AuthRequest): RequestUser {
    if (req.apiKey || req.user?.apiKeyId) {
      throw new ForbiddenException('API keys cannot grant OAuth access');
    }
    if (!req.user) throw new ForbiddenException('Sign-in required');
    return req.user;
  }

  /** Whether OAuth login is offered and the MCP URL to connect to. */
  @Public()
  @Get('info')
  info() {
    return this.oauth.info();
  }

  @Get('requests/:id')
  async getRequest(@Param('id') id: string, @Req() req: AuthRequest) {
    this.requireUser(req);
    const info = await this.oauth.getAuthRequest(id);
    if (!info) throw new NotFoundException('Authorization request not found or expired');
    return {
      clientName: info.clientName,
      redirectHost: info.redirectHost,
      redirectUri: info.redirectUri,
      expiresAt: info.expiresAt,
    };
  }

  // `service`: an account action, not a content write. The connection never
  // exceeds the owner's own rights, and a project restriction is checked
  // against the actor via actorCanAccessProject below.
  @PermissionGate('service')
  @Post('requests/:id/decision')
  async decide(@Param('id') id: string, @Body() body: OAuthDecisionDto, @Req() req: AuthRequest) {
    const actor = this.requireUser(req);
    // Checked again here so the endpoint is safe even without the ValidationPipe.
    if (!isRecord(body) || typeof body.approve !== 'boolean') {
      throw new BadRequestException('approve must be a boolean');
    }
    if (!body.approve) return this.oauth.decide(id, actor.userId, { approve: false });

    const raw: unknown = body.projectIds;
    if (raw === undefined) return this.oauth.decide(id, actor.userId, { approve: true });
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('projectIds must be a non-empty list; omit it for no restriction');
    }
    const projectIds: string[] = [];
    for (const p of raw) {
      if (typeof p !== 'string' || !Types.ObjectId.isValid(p) || p.length !== 24) {
        throw new BadRequestException('Invalid projectId');
      }
      projectIds.push(p);
    }
    // Same data-scope rule as every other project access.
    if (!projectIds.every((p) => actorCanAccessProject(actor, p))) {
      throw new ForbiddenException('No access to one of the selected projects');
    }
    return this.oauth.decide(id, actor.userId, { approve: true, projectIds });
  }

  /** The signed-in user's connected apps. */
  @Get('connections')
  async listConnections(@Req() req: AuthRequest) {
    const actor = this.requireUser(req);
    return this.oauth.listConnections(actor.userId);
  }

  /**
   * Revokes one of the user's own connections; foreign or unknown → 404.
   * `service`: taking access away must not need `project:write` — the
   * service checks ownership itself.
   */
  @PermissionGate('service')
  @Delete('connections/:id')
  async revokeConnection(@Param('id') id: string, @Req() req: AuthRequest) {
    const actor = this.requireUser(req);
    await this.oauth.revokeOwnConnection(actor.userId, id);
    return { revoked: true };
  }

  /** Admin: revokes any user's connection (admin key overview). */
  @PermissionGate('service')
  @Delete('admin/connections/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @AdminPermission(Permission.ADMIN_APIKEY_MANAGE)
  async adminRevokeConnection(@Param('id') id: string, @Req() req: AuthRequest) {
    this.requireUser(req);
    await this.oauth.revokeAnyConnection(id);
    return { revoked: true };
  }
}
