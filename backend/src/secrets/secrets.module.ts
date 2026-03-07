import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Secret, SecretSchema } from './schemas/secret.schema';
import { SecretsService } from './secrets.service';
import { SecretsController } from './secrets.controller';
import { EncryptionService } from '../common/encryption.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Secret.name, schema: SecretSchema }]),
  ],
  controllers: [SecretsController],
  providers: [SecretsService, EncryptionService],
  exports: [SecretsService, EncryptionService],
})
export class SecretsModule {}
