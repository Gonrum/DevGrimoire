import { Controller, Get, Put, Param, Query, HttpCode } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findAll(
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notificationsService.findAll(
      limit ? parseInt(limit, 10) : undefined,
      unreadOnly === 'true',
    );
  }

  @Get('unread-count')
  async unreadCount() {
    const count = await this.notificationsService.unreadCount();
    return { count };
  }

  @Put(':id/read')
  @HttpCode(200)
  markAsRead(@Param('id') id: string) {
    return this.notificationsService.markAsRead(id);
  }

  @Put('read-all')
  @HttpCode(204)
  markAllAsRead() {
    return this.notificationsService.markAllAsRead();
  }
}
