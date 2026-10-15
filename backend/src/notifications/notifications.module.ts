import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppNotification, NotificationSchema } from './schemas/notification.schema';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PushModule } from '../push/push.module';
import { SettingsModule } from '../settings/settings.module';
import { User, UserSchema } from '../auth/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AppNotification.name, schema: NotificationSchema },
      // Persönliche Benachrichtigungs-Einstellungen (notificationPrefs).
      { name: User.name, schema: UserSchema },
    ]),
    PushModule,
    SettingsModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
