import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { WorkspacesService } from './workspaces.service';
import { KubeClustersService } from '../kube/kube-clusters.service';
import { KubeClientService } from '../kube/kube-client.service';
import { KubeResourcesService } from '../kube/kube-resources.service';
import { KubeLogsService } from '../kube/kube-logs.service';
import { KubeAuditService } from '../kube/kube-audit.service';
import { KubeAuditAction } from '../kube/schemas/kube-audit.schema';
import { KubeClusterDocument } from '../kube/schemas/kube-cluster.schema';
import { KUBE_KINDS, KubeKind } from '../kube/kube-kinds';
import { kubeTop, KUBE_TOP_SCOPES, KubeTopScope } from '../kube/kube-top';
import { WorkspaceCliClaim } from './workspace-cli-token.service';
import { kubeApiExceptionCode, kubeApiExceptionMessage } from '../kube/kube-errors';

/**
 * Cluster-Fehler wie am REST-Controller abbilden: 4xx vom Cluster bleibt 4xx
 * mit lesbarer Meldung („pods \"x\" not found"), alles andere aus dem
 * Cluster-Zugriff wird 503. Ohne das kam bei `dg` jeder Cluster-Fehler als
 * nichtssagender 500 an.
 */
async function clusterCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    const code = kubeApiExceptionCode(err);
    if (code !== undefined && code >= 400 && code < 500) {
      throw new HttpException(kubeApiExceptionMessage(err), code);
    }
    throw new ServiceUnavailableException(kubeApiExceptionMessage(err));
  }
}

/** Wie `kube_logs` über MCP: harte Obergrenze unabhängig von tailLines/since. */
const LOG_LINES_HARD_CAP = 5000;
/** …und ein Byte-Budget, das schon beim Einsammeln greift (M-18). */
const LOG_BYTES_CAP = 1024 * 1024;

/** Slug oder 24-Hex-Id. Beides passt auf dasselbe Muster, unterschieden wird am Format. */
const CLUSTER_REF = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

class DgKubeClusterRef {
  @IsOptional() @IsString() @Matches(CLUSTER_REF)
  cluster?: string;
}

class DgKubeGetDto extends DgKubeClusterRef {
  @IsIn(KUBE_KINDS)
  kind!: KubeKind;

  @IsOptional() @IsString() @MaxLength(253)
  name?: string;

  @IsOptional() @IsString() @MaxLength(63)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  labelSelector?: string;

  @IsOptional() @IsInt() @Min(1) @Max(500)
  limit?: number;
}

class DgKubeDescribeDto extends DgKubeClusterRef {
  @IsIn(KUBE_KINDS)
  kind!: KubeKind;

  @IsString() @MaxLength(253)
  name!: string;

  @IsOptional() @IsString() @MaxLength(63)
  namespace?: string;
}

class DgKubeEventsDto extends DgKubeClusterRef {
  @IsOptional() @IsString() @MaxLength(63)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(253)
  involvedName?: string;

  @IsOptional() @IsIn(KUBE_KINDS)
  involvedKind?: KubeKind;

  @IsOptional() @IsInt() @Min(1) @Max(500)
  limit?: number;
}

class DgKubeLogsDto extends DgKubeClusterRef {
  @IsString() @MaxLength(63)
  namespace!: string;

  @IsString() @MaxLength(253)
  pod!: string;

  @IsOptional() @IsString() @MaxLength(253)
  container?: string;

  @IsOptional() @IsInt() @Min(1) @Max(LOG_LINES_HARD_CAP)
  tailLines?: number;

  @IsOptional() @IsBoolean()
  previous?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(30 * 24 * 3600)
  sinceSeconds?: number;
}

class DgKubeTopDto extends DgKubeClusterRef {
  @IsOptional() @IsIn(KUBE_TOP_SCOPES)
  scope?: KubeTopScope;

  @IsOptional() @IsString() @MaxLength(63)
  namespace?: string;
}

/**
 * `dg kube …` — lesender Cluster-Zugriff aus einer Workspace-Shell (C-3).
 *
 * Ersetzt die Kube-Sessions im Sidecar: dort lag die Kubeconfig als Datei
 * unter derselben UID wie jede Workspace-Shell und war damit für jede Shell
 * lesbar. Hier verlassen die Credentials das Backend nie; die Shell bekommt
 * nur das Ergebnis.
 *
 * Scope: ausschliesslich Cluster, die direkt am Projekt des Tokens hängen.
 * Kunden-gebundene Cluster bewusst NICHT — ein Nutzer mit Projekt-Scope sieht
 * sie über die UI auch nicht, und der Token hat keinen Nutzer, dessen
 * Kunden-Scope man prüfen könnte.
 *
 * Die Route ist @Public (kein Nutzer-JWT), RequestContext hat also keinen
 * Actor — und `KubeClustersService.findById()` prüft ohne Actor nichts. Die
 * Projektprüfung in `resolveCluster()` ist deshalb die einzige Grenze und
 * darf nicht wegfallen.
 */
@Controller('internal/dg/kube')
@Public()
@UseGuards(WorkspaceCliAuthGuard)
export class WorkspaceCliKubeController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly clusters: KubeClustersService,
    private readonly kubeClient: KubeClientService,
    private readonly resources: KubeResourcesService,
    private readonly logs: KubeLogsService,
    private readonly audit: KubeAuditService,
  ) {}

  @Post('clusters')
  async listClusters(@Req() req: Request) {
    const claim = await this.claim(req);
    const docs = await this.clusters.findByProjectId(claim.projectId);
    return docs.map((d) => ({
      clusterId: d._id.toString(),
      slug: d.slug,
      label: d.label,
      defaultNamespace: d.defaultNamespace,
      readOnly: d.readOnly,
      transport: d.transport,
    }));
  }

  @Post('get')
  async get(@Req() req: Request, @Body() dto: DgKubeGetDto) {
    const claim = await this.claim(req);
    const cluster = await this.resolveCluster(claim, dto.cluster);
    const clusterId = cluster._id.toString();
    const startedAt = Date.now();
    const result = await clusterCall(() => (dto.name
      ? this.resources.get(clusterId, dto.kind, dto.name, dto.namespace)
      : this.resources.list(clusterId, dto.kind, {
        namespace: dto.namespace, labelSelector: dto.labelSelector, limit: dto.limit,
      })));
    await this.record(claim, clusterId, dto.name ? 'get' : 'list', startedAt, {
      resource: dto.kind, namespace: dto.namespace, name: dto.name,
    });
    return result;
  }

  @Post('describe')
  async describe(@Req() req: Request, @Body() dto: DgKubeDescribeDto) {
    const claim = await this.claim(req);
    const cluster = await this.resolveCluster(claim, dto.cluster);
    const clusterId = cluster._id.toString();
    const startedAt = Date.now();
    const result = await clusterCall(() => this.resources.describe(clusterId, dto.kind, dto.name, dto.namespace));
    await this.record(claim, clusterId, 'get', startedAt, {
      resource: dto.kind, namespace: dto.namespace, name: dto.name,
    });
    return result;
  }

  @Post('events')
  async events(@Req() req: Request, @Body() dto: DgKubeEventsDto) {
    const claim = await this.claim(req);
    const cluster = await this.resolveCluster(claim, dto.cluster);
    const clusterId = cluster._id.toString();
    const startedAt = Date.now();
    const result = await clusterCall(() => this.resources.events(clusterId, {
      namespace: dto.namespace,
      involvedName: dto.involvedName,
      involvedKind: dto.involvedKind,
      limit: dto.limit,
    }));
    await this.record(claim, clusterId, 'list', startedAt, {
      resource: 'Event', namespace: dto.namespace, name: dto.involvedName,
    });
    return result;
  }

  /** Nie `follow` — der Aufruf käme sonst nicht zurück (wie bei kube_logs). */
  @Post('logs')
  async podLogs(@Req() req: Request, @Body() dto: DgKubeLogsDto) {
    const claim = await this.claim(req);
    const cluster = await this.resolveCluster(claim, dto.cluster);
    const clusterId = cluster._id.toString();
    const startedAt = Date.now();
    const session = await clusterCall(() => this.logs.open(clusterId, dto.namespace, dto.pod, {
      container: dto.container,
      tailLines: dto.tailLines ?? 200,
      previous: dto.previous,
      sinceSeconds: dto.sinceSeconds,
      follow: false,
    }));
    const lines: string[] = [];
    let status: 'complete' | 'truncated' | 'dropped' = 'complete';
    let error: string | undefined;
    let bytes = 0;
    try {
      for await (const line of session.lines) {
        lines.push(line);
        bytes += Buffer.byteLength(line, 'utf8') + 8;
        if (lines.length >= LOG_LINES_HARD_CAP || bytes >= LOG_BYTES_CAP) { status = 'truncated'; break; }
      }
      // session.error() ist erst nach vollständigem Durchlauf aussagekräftig.
      if (status === 'complete') {
        error = session.error();
        if (error) status = 'dropped';
      }
    } finally {
      session.close();
    }
    await this.record(claim, clusterId, 'logs', startedAt, {
      resource: 'Pod', namespace: dto.namespace, name: dto.pod,
    });
    return { lines, lineCount: lines.length, status, ...(error ? { error } : {}) };
  }

  @Post('top')
  async top(@Req() req: Request, @Body() dto: DgKubeTopDto) {
    const claim = await this.claim(req);
    const cluster = await this.resolveCluster(claim, dto.cluster);
    const scope = dto.scope ?? 'pods';
    const startedAt = Date.now();
    const result = await clusterCall(() => kubeTop(this.kubeClient, cluster, scope, dto.namespace));
    await this.record(claim, cluster._id.toString(), 'metrics_query', startedAt, {
      resource: scope === 'nodes' ? 'Node' : 'Pod', namespace: dto.namespace,
    });
    return result;
  }

  /**
   * Token-Claim plus Gegenprüfung am Workspace — wie `dg save`. Ein Token
   * eines inzwischen gelöschten oder umgehängten Workspace soll nichts mehr
   * dürfen, auch wenn er formal noch gültig ist.
   */
  private async claim(req: Request): Promise<WorkspaceCliClaim> {
    const claim = req.workspaceCli!;
    const ws = await this.workspaces.findById(claim.workspaceId);
    if (ws.projectId?.toString() !== claim.projectId) {
      throw new ForbiddenException('workspace/project mismatch');
    }
    return claim;
  }

  /**
   * Cluster über Slug oder Id — nur aus dem Projekt des Tokens. Ohne Angabe
   * gilt der einzige Cluster des Projekts; bei mehreren muss gewählt werden.
   * Ein fremder Cluster ist „nicht gefunden", nicht „verboten": die Antwort
   * soll nicht verraten, dass es die Id gibt.
   */
  private async resolveCluster(
    claim: WorkspaceCliClaim,
    ref: string | undefined,
  ): Promise<KubeClusterDocument> {
    if (!ref) {
      const docs = await this.clusters.findByProjectId(claim.projectId);
      if (docs.length === 1) return docs[0];
      if (docs.length === 0) throw new NotFoundException('Dieses Projekt hat keinen Kubernetes-Cluster');
      throw new BadRequestException(
        `Mehrere Cluster im Projekt, bitte --cluster angeben: ${docs.map((d) => d.slug).join(', ')}`,
      );
    }
    let cluster: KubeClusterDocument | undefined;
    try {
      cluster = OBJECT_ID.test(ref)
        ? await this.clusters.findById(ref)
        : await this.clusters.findBySlug(ref, { projectId: claim.projectId });
    } catch {
      cluster = undefined;
    }
    if (!cluster || cluster.projectId?.toString() !== claim.projectId) {
      throw new NotFoundException(`Cluster "${ref}" nicht gefunden`);
    }
    return cluster;
  }

  private record(
    claim: WorkspaceCliClaim,
    clusterId: string,
    action: KubeAuditAction,
    startedAt: number,
    details: { resource?: string; namespace?: string; name?: string },
  ): Promise<void> {
    return this.audit.record({
      clusterId,
      action,
      sourceContext: 'dg',
      workspaceId: claim.workspaceId,
      ...details,
      durationMs: Date.now() - startedAt,
    });
  }
}
