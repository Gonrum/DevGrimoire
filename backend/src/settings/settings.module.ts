import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Setting, SettingSchema } from './schemas/setting.schema';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { EncryptionService } from '../common/encryption.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Setting.name, schema: SettingSchema },
    ]),
  ],
  controllers: [SettingsController],
  providers: [SettingsService, EncryptionService],
  exports: [SettingsService],
})
export class SettingsModule {}
