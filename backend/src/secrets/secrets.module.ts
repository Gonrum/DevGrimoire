import { Module, OnModuleInit } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Secret, SecretDocument, SecretSchema } from './schemas/secret.schema';
import { SecretsService } from './secrets.service';
import { SecretsController } from './secrets.controller';
import { EncryptionService } from '../common/encryption.service';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Secret.name, schema: SecretSchema }]),
    CustomersModule,
  ],
  controllers: [SecretsController],
  providers: [SecretsService, EncryptionService],
  exports: [SecretsService, EncryptionService],
})
export class SecretsModule implements OnModuleInit {
  constructor(
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
  ) {}

  async onModuleInit() {
    // Migration: drop old non-partial unique index from before customerId support
    try {
      await this.secretModel.collection.dropIndex('projectId_1_environmentId_1_key_1');
    } catch {
      // Already migrated or never existed
    }
    await this.secretModel.syncIndexes();
  }
}
