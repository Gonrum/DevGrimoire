import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SshConnection,
  SshConnectionSchema,
} from './schemas/ssh-connection.schema';
import { SshAudit, SshAuditSchema } from './schemas/ssh-audit.schema';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';
import { SshService } from './ssh.service';
import { SshTestService } from './ssh-test.service';
import { SshSessionService } from './ssh-session.service';
import { SshController } from './ssh.controller';
import { SecretsModule } from '../secrets/secrets.module';
import { NotificationsModule } from '../notifications/notifications.module';

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
    // Auth-failure push (T-385 §6.6) routes through NotificationsService.
    NotificationsModule,
  ],
  controllers: [SshController],
  // SshSessionService is exported so main.ts can grab it via `app.get(...)`
  // for the WS-terminal route (same pattern as WorkspacesService).
  providers: [SshService, SshTestService, SshSessionService],
  exports: [SshService, SshTestService, SshSessionService],
})
export class SshModule {}
