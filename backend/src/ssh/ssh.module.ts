import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SshConnection,
  SshConnectionSchema,
} from './schemas/ssh-connection.schema';
import { SshAudit, SshAuditSchema } from './schemas/ssh-audit.schema';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';
import { SshService } from './ssh.service';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SshConnection.name, schema: SshConnectionSchema },
      { name: SshAudit.name, schema: SshAuditSchema },
      // We register Secret here too so SshService can patch the
      // `ownedBySshConnectionId` marker directly (cascade-delete pivot).
      // The owning module remains SecretsModule, which sets up indexes etc.
      { name: Secret.name, schema: SecretSchema },
    ]),
    SecretsModule,
  ],
  providers: [SshService],
  exports: [SshService],
})
export class SshModule {}
