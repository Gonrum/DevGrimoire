import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { KubeClustersService } from './kube-clusters.service';
import { KubeClientService, KubeConnectionTestResult } from './kube-client.service';
import { parseKubeconfig } from './kubeconfig-parser';
import { CreateKubeClusterDto } from './dto/create-kube-cluster.dto';
import { UpdateKubeClusterDto } from './dto/update-kube-cluster.dto';
import { ListKubeClustersDto } from './dto/list-kube-clusters.dto';
import { ParseKubeconfigDto } from './dto/parse-kubeconfig.dto';
import { KubeClusterDocument } from './schemas/kube-cluster.schema';
import { KubeAuditService } from './kube-audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';

/** `req.user.userId` wird vom global registrierten JwtAuthGuard gesetzt. */
interface AuthRequest {
  user?: { userId?: string };
}

/**
 * Auth: `JwtAuthGuard` hängt global in app.module.ts, deshalb kein
 * `@UseGuards` für die Lese- und CRUD-Routen. Das Umschalten der
 * Rechte-Flags ist Admin-only — das ist der eigentliche Hebel.
 */
@Controller('kube-clusters')
export class KubeController {
  constructor(
    private readonly clusters: KubeClustersService,
    private readonly client: KubeClientService,
    private readonly audit: KubeAuditService,
  ) {}

  /**
   * Projektion für alle nach aussen gehenden Antworten. Weder die
   * Kubeconfig noch ihre Secret-Referenz verlassen den Server.
   */
  private toResponse(doc: KubeClusterDocument) {
    return {
      _id: doc._id.toString(),
      label: doc.label,
      slug: doc.slug,
      projectId: doc.projectId?.toString(),
      customerId: doc.customerId?.toString(),
      contextName: doc.contextName,
      clusterServer: doc.clusterServer,
      defaultNamespace: doc.defaultNamespace,
      transport: doc.transport,
      sshConnectionId: doc.sshConnectionId?.toString(),
      readOnly: doc.readOnly,
      allowMcpWrites: doc.allowMcpWrites,
      allowInsecureTls: doc.allowInsecureTls,
      prometheus: doc.prometheus,
      description: doc.description,
      tags: doc.tags,
      lastConnectedAt: doc.lastConnectedAt,
      lastConnectError: doc.lastConnectError,
    };
  }

  @Post('parse-kubeconfig')
  @HttpCode(200)
  parse(@Body() dto: ParseKubeconfigDto) {
    return parseKubeconfig(dto.kubeconfig);
  }

  @Get()
  async list(@Query() q: ListKubeClustersDto) {
    const docs = q.projectId
      ? await this.clusters.findByProjectId(q.projectId)
      : q.customerId
        ? await this.clusters.findByCustomerId(q.customerId)
        : [];
    return docs.map((d) => this.toResponse(d));
  }

  @Post()
  async create(@Body() dto: CreateKubeClusterDto) {
    return this.toResponse(await this.clusters.create(dto));
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.clusters.findById(id));
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async update(@Param('id') id: string, @Body() dto: UpdateKubeClusterDto) {
    return this.toResponse(await this.clusters.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.clusters.delete(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<KubeConnectionTestResult> {
    return this.client.test(id, req.user?.userId || 'system');
  }

  @Get(':id/audit')
  async auditLog(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { items, total } = await this.audit.list(id, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return {
      total,
      items: items.map((a) => ({
        at: a.at,
        action: a.action,
        sourceContext: a.sourceContext,
        verb: a.verb,
        resource: a.resource,
        namespace: a.namespace,
        name: a.name,
        durationMs: a.durationMs,
        errorMsg: a.errorMsg,
      })),
    };
  }
}
