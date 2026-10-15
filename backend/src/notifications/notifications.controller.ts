import { Controller, Get, Put, Delete, Param, Query, HttpCode, Body } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsString, Matches, ValidateNested,
} from 'class-validator';
import { NotificationsService } from './notifications.service';
import { CATEGORY_PATTERN, HHMM_PATTERN, MAX_CATEGORIES } from './notification-prefs';

class QuietHoursDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString() @Matches(HHMM_PATTERN)
  from!: string;

  @IsString() @Matches(HHMM_PATTERN)
  to!: string;

  @IsArray() @ArrayMaxSize(MAX_CATEGORIES) @IsString({ each: true }) @Matches(CATEGORY_PATTERN, { each: true })
  overrides!: string[];
}

class NotificationPrefsDto {
  @IsArray() @ArrayMaxSize(MAX_CATEGORIES) @IsString({ each: true }) @Matches(CATEGORY_PATTERN, { each: true })
  pushCategories!: string[];

  // Ohne @IsDefined überspringt @ValidateNested ein fehlendes Feld.
  @IsDefined() @ValidateNested() @Type(() => QuietHoursDto)
  quietHours!: QuietHoursDto;
}

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

  /** Eigene Push-Kategorien und Ruhezeiten — für jeden Nutzer, nicht nur Admins. */
  @Get('preferences')
  getPreferences() {
    return this.notificationsService.getPreferences();
  }

  @Put('preferences')
  @HttpCode(200)
  setPreferences(@Body() body: NotificationPrefsDto) {
    return this.notificationsService.setPreferences({
      pushCategories: [...new Set(body.pushCategories)],
      quietHours: {
        enabled: body.quietHours.enabled,
        from: body.quietHours.from,
        to: body.quietHours.to,
        overrides: [...new Set(body.quietHours.overrides)],
      },
    });
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
