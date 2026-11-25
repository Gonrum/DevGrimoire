import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { Types } from 'mongoose';
import { actorCanAccessProject } from '../common/permissions';
import { isRecord } from '../common/narrow';
import type { AuthRequest, RequestUser } from '../common/request-context';
import { OAuthDecisionDto } from './dto/oauth-decision.dto';
import { OAuthService } from './oauth.service';

/**
 * Consent REST endpoint for the MCP OAuth flow. Not `@Public()`: the global
 * JWT guard authenticates the logged-in user in the browser. API-key actors
 * are refused — a key must never be able to mint another connection.
 */
@Controller('oauth/requests')
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

  @Get(':id')
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

  @Post(':id/decision')
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
}
