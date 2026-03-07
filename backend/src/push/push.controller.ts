import { Controller, Post, Delete, Get, Body } from '@nestjs/common';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: this.pushService.getPublicKey() };
  }

  @Post('subscribe')
  async subscribe(@Body() body: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    await this.pushService.subscribe(body);
    return { ok: true };
  }

  @Delete('subscribe')
  async unsubscribe(@Body() body: { endpoint: string }) {
    await this.pushService.unsubscribe(body.endpoint);
    return { ok: true };
  }
}
