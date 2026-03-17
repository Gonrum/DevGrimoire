import { Controller, Get, Put, Delete, Param, Query, HttpCode } from '@nestjs/common';
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
      Math.min(limit ? parseInt(limit, 10) : 50, 200),
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

  @Delete('all')
  @HttpCode(200)
  deleteAll() {
    return this.notificationsService.deleteAll();
  }

  @Delete(':id')
  @HttpCode(200)
  delete(@Param('id') id: string) {
    return this.notificationsService.delete(id);
  }
}
