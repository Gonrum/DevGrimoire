import { Controller, Post, Delete, Get, Body, Req, BadRequestException } from '@nestjs/common';
import { PushService } from './push.service';
import { AuthRequest } from '../common/request-context';

interface SubscriptionBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

/**
 * `endpoint` und die Keys MÜSSEN Strings sein: ohne Prüfung ging z. B.
 * `{"endpoint":{"$ne":null}}` als Mongo-Operator in den Filter (H-12).
 */
function requireEndpoint(body: SubscriptionBody | undefined): string {
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) {
    throw new BadRequestException('endpoint must be an https URL string');
  }
  return endpoint;
}

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: this.pushService.getPublicKey() };
  }

  @Post('subscribe')
  async subscribe(@Body() body: SubscriptionBody, @Req() req: AuthRequest) {
    const endpoint = requireEndpoint(body);
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') {
      throw new BadRequestException('keys.p256dh and keys.auth must be strings');
    }
    await this.pushService.subscribe({ endpoint, keys: { p256dh, auth } }, req.user?.userId ?? null);
    return { ok: true };
  }

  @Delete('subscribe')
  async unsubscribe(@Body() body: SubscriptionBody, @Req() req: AuthRequest) {
    await this.pushService.unsubscribe(requireEndpoint(body), req.user?.userId ?? null);
    return { ok: true };
  }
}
