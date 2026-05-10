import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { MonitoringScheduler } from './monitoring.scheduler';
import { Healthcheck, HealthcheckSchema } from './schemas/healthcheck.schema';
import {
  HealthcheckHistory,
  HealthcheckHistorySchema,
} from './schemas/healthcheck-history.schema';
import { CustomersModule } from '../customers/customers.module';
import { SecretsModule } from '../secrets/secrets.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Healthcheck.name, schema: HealthcheckSchema },
      { name: HealthcheckHistory.name, schema: HealthcheckHistorySchema },
    ]),
    CustomersModule,
    SecretsModule,
    NotificationsModule,
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService, MonitoringScheduler],
  exports: [MonitoringService],
})
export class MonitoringModule {}
