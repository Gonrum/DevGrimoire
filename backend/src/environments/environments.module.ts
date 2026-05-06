import { Module, OnModuleInit } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Environment, EnvironmentDocument, EnvironmentSchema } from './schemas/environment.schema';
import { EnvironmentsService } from './environments.service';
import { EnvironmentsController } from './environments.controller';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Environment.name, schema: EnvironmentSchema }]),
    CustomersModule,
  ],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule implements OnModuleInit {
  constructor(
    @InjectModel(Environment.name) private envModel: Model<EnvironmentDocument>,
  ) {}

  async onModuleInit() {
    // Migration: drop old non-partial unique index from before customerId support
    try {
      await this.envModel.collection.dropIndex('projectId_1_name_1');
    } catch {
      // Already migrated or never existed
    }
    await this.envModel.syncIndexes();
  }
}
