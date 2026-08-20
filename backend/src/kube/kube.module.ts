import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KubeCluster, KubeClusterSchema } from './schemas/kube-cluster.schema';
import { KubeAudit, KubeAuditSchema } from './schemas/kube-audit.schema';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';
import { KubeClustersService } from './kube-clusters.service';
import { KubeTransportService } from './kube-transport.service';
import { KubeClientService } from './kube-client.service';
import { KubeAuditService } from './kube-audit.service';
import { KubeController } from './kube.controller';
import { SecretsModule } from '../secrets/secrets.module';
import { SshModule } from '../ssh/ssh.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KubeCluster.name, schema: KubeClusterSchema },
      { name: KubeAudit.name, schema: KubeAuditSchema },
      // Secret ist hier registriert, damit KubeClustersService den
      // ownedByKubeClusterId-Marker setzen und beim Delete kaskadieren
      // kann. Eigentümer des Schemas bleibt SecretsModule.
      { name: Secret.name, schema: SecretSchema },
    ]),
    SecretsModule,
    // SshSessionService liefert openTunnel für transport="ssh-tunnel".
    SshModule,
  ],
  controllers: [KubeController],
  providers: [KubeClustersService, KubeTransportService, KubeClientService, KubeAuditService],
  exports: [KubeClustersService, KubeClientService, KubeTransportService, KubeAuditService],
})
export class KubeModule {}
