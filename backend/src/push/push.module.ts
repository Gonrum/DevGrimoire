import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PushSubscriptionEntry, PushSubscriptionSchema } from './schemas/push-subscription.schema';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { User, UserSchema } from '../auth/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PushSubscriptionEntry.name, schema: PushSubscriptionSchema },
      // Nur lesend, für den Projekt-Scope der Abo-Besitzer. Direkt das Modell
      // statt AuthService, um keinen Modul-Zyklus über Notifications zu bauen.
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
