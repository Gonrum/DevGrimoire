import { Controller, Get, Put, Param, Body } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get(':key')
  async get(@Param('key') key: string) {
    const value = await this.settingsService.get(key);
    return { key, value };
  }

  @Put(':key')
  async set(@Param('key') key: string, @Body() body: { value: string }) {
    const setting = await this.settingsService.set(key, body.value);
    return { key: setting.key, value: setting.value };
  }
}
