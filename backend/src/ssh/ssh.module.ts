import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SshConnection,
  SshConnectionSchema,
} from './schemas/ssh-connection.schema';
import { SshAudit, SshAuditSchema } from './schemas/ssh-audit.schema';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';
import {
  CustomerProjectLink,
  CustomerProjectLinkSchema,
} from '../customers/schemas/customer-project-link.schema';
import { SshService } from './ssh.service';
import { SshTestService } from './ssh-test.service';
import { SshSessionService } from './ssh-session.service';
import { SshController } from './ssh.controller';
import { SecretsModule } from '../secrets/secrets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SshConnection.name, schema: SshConnectionSchema },
      { name: SshAudit.name, schema: SshAuditSchema },
      // We register Secret here too so SshService can patch the
      // `ownedBySshConnectionId` marker directly (cascade-delete pivot).
      // The owning module remains SecretsModule, which sets up indexes etc.
      { name: Secret.name, schema: SecretSchema },
      // CustomerProjectLink is read-only here — SshService.findByProjectId
      // joins through it to expose customer-scoped connections in linked
      // projects as inherited (T-386). The schema is owned by
      // CustomersModule; this registration is purely about wiring up
      // `getModelToken` in this module's injector.
      { name: CustomerProjectLink.name, schema: CustomerProjectLinkSchema },
    ]),
    SecretsModule,
    // Auth-failure push (T-385 §6.6) routes through NotificationsService.
    NotificationsModule,
    // Global `ssh.maxUploadBytes` setting for the effective upload-limit resolver.
    SettingsModule,
  ],
  controllers: [SshController],
  // SshSessionService is exported so main.ts can grab it via `app.get(...)`
  // for the WS-terminal route (same pattern as WorkspacesService).
  providers: [SshService, SshTestService, SshSessionService],
  exports: [SshService, SshTestService, SshSessionService],
})
export class SshModule {}
