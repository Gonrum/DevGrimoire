import {
  Controller, Get, Post, Put, Patch, Param, Body, Query, HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { REPLICATION_STATUS_CHANGED } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationReceiveService } from './replication-receive.service';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { ReplicationPullService } from './replication-pull.service';
import { ReplicationScheduler } from './replication.scheduler';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_MASTER_URL, REPL_PEER_URL, REPL_PEER_API_KEY,
  REPL_LAST_SYNC, REPL_LAST_FULL_SYNC, REPL_LAST_PULL,
  REPL_FULL_SYNC_CRON, REPL_PULL_CRON, REPL_INSTANCE_ID,
  ReplicationPayload, ReplicationConfig, ReplicationStatus, ReplicationPullResponse,
} from './replication.constants';
import { randomUUID } from 'crypto';

/** Maps entity types to MongoDB collection names — used by the pull endpoint
 *  for delta lookups. Mirrors the table in the push/receive services. */
const PULL_ENTITY_COLLECTIONS: Record<string, string> = {
  todo: 'todos',
  session: 'sessions',
  knowledge: 'knowledges',
  changelog: 'changelogs',
  milestone: 'milestones',
  manual: 'manuals',
  research: 'researches',
  environment: 'environments',
  secret: 'secrets',
  schema: 'dbschemas',
  dependency: 'dependencies',
  feature: 'features',
  soul: 'souls',
  commit: 'commits',
  'recurring-task': 'recurringtasks',
  snippet: 'snippets',
  attachment: 'attachments',
  release: 'releases',
};

/** Hard cap on entities per pull response — keeps payloads bounded. The client
 *  re-pulls until it sees count < limit, so a backlog catches up over multiple
 *  rounds rather than blowing memory in one shot. */
const PULL_MAX_DOCS = 500;

@Controller('replication')
export class ReplicationController {
  constructor(
    private receiveService: ReplicationReceiveService,
    private pushService: ReplicationPushService,
    private fullSyncService: ReplicationFullSyncService,
    private pullService: ReplicationPullService,
    private scheduler: ReplicationScheduler,
    private settingsService: SettingsService,
    private projectsService: ProjectsService,
    private httpService: HttpService,
    @InjectConnection() private connection: Connection,
    private eventEmitter: EventEmitter2,
  ) {}

  // ── Per-project replication opt-in ─────────────

  @Get('projects')
  async listProjectsForReplication() {
    const projects = await this.projectsService.findAll(true);
    return projects.map((p) => ({
      _id: p._id.toString(),
      name: p.name,
      active: p.active,
      favorite: p.favorite,
      replicationEnabled: !!p.replicationConfig?.enabled,
    }));
  }

  @Patch('projects/:id')
  @Roles(UserRole.ADMIN)
  async setProjectReplication(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('enabled (boolean) is required');
    }
    const project = await this.projectsService.setReplicationEnabled(id, body.enabled);
    return {
      _id: project._id.toString(),
      name: project.name,
      replicationEnabled: !!project.replicationConfig?.enabled,
    };
  }

  /**
   * T-96: Admin browses projects that exist on the configured peer/slave.
   * Useful for pulling in projects that only exist on the remote side. Returns
   * peer's project list merged with local existence info so the UI can mark
   * which entries are already mirrored here.
   */
  @Get('remote-projects')
  @Roles(UserRole.ADMIN)
  async listRemoteProjects() {
    const role = await this.settingsService.get(REPL_ROLE);
    const counterpartyUrl = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_URL)
      : await this.settingsService.get(REPL_SLAVE_URL);
    const apiKey = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_API_KEY)
      : await this.settingsService.get(REPL_SLAVE_API_KEY);
    if (!counterpartyUrl) {
      throw new BadRequestException(
        role === 'peer' ? 'No peer URL configured' : 'No slave URL configured',
      );
    }

    let remote: Array<{
      _id: string;
      name: string;
      active: boolean;
      favorite: boolean;
      replicationEnabled: boolean;
    }>;
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${counterpartyUrl}/api/replication/projects`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          timeout: 15000,
        }),
      );
      remote = response.data;
    } catch (err) {
      throw new BadRequestException(`Peer unreachable: ${(err as Error).message}`);
    }

    // Build a lookup of local projects (includeInactive=true to cover archived)
    const localProjects = await this.projectsService.findAll(true);
    const localMap = new Map(
      localProjects.map((p) => [
        p._id.toString(),
        { enabled: !!p.replicationConfig?.enabled },
      ]),
    );

    return remote.map((rp) => ({
      _id: rp._id,
      name: rp.name,
      active: rp.active,
      favorite: rp.favorite,
      remoteReplicationEnabled: rp.replicationEnabled,
      existsLocally: localMap.has(rp._id),
      localReplicationEnabled: localMap.get(rp._id)?.enabled ?? false,
    }));
  }

  /**
   * T-96: Import a peer-only project by asking the peer to enable replication
   * for it. The peer's auto-sync-on-enable (commit 0bba09a) then pushes the
   * project + entities here via the existing bootstrap path in applyFullSync.
   * We don't create anything locally — the inbound full-sync does.
   */
  @Post('import-project/:id')
  @HttpCode(202)
  @Roles(UserRole.ADMIN)
  async importProjectFromPeer(@Param('id') id: string) {
    const role = await this.settingsService.get(REPL_ROLE);
    const counterpartyUrl = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_URL)
      : await this.settingsService.get(REPL_SLAVE_URL);
    const apiKey = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_API_KEY)
      : await this.settingsService.get(REPL_SLAVE_API_KEY);
    if (!counterpartyUrl) {
      throw new BadRequestException(
        role === 'peer' ? 'No peer URL configured' : 'No slave URL configured',
      );
    }
    if (!apiKey) {
      throw new BadRequestException('Peer API key required to enable replication remotely');
    }

    try {
      await firstValueFrom(
        this.httpService.patch(
          `${counterpartyUrl}/api/replication/projects/${id}`,
          { enabled: true },
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 15000,
          },
        ),
      );
    } catch (err) {
      throw new BadRequestException(`Failed to enable replication on peer: ${(err as Error).message}`);
    }

    // If the project also exists locally, flip the local flag too. Keeps both
    // sides symmetric and prevents LWW from dropping the peer's project-doc
    // push when our local updatedAt happens to be newer.
    try {
      await this.projectsService.setReplicationEnabled(id, true);
    } catch {
      // Project doesn't exist locally yet — bootstrap will create it via
      // applyFullSync/applyChange when the peer's auto-sync fires.
    }

    return {
      triggered: true,
      projectId: id,
      message: 'Replication enabled on peer. Auto-sync will push the project shortly.',
    };
  }

  // ── Config CRUD ──────────────────────────────────

  @Get('config')
  async getConfig(): Promise<ReplicationConfig> {
    const [role, slaveUrl, slaveApiKey, masterUrl, peerUrl, peerApiKey, cron, pullCron, instanceId] = await Promise.all([
      this.settingsService.getOrDefault(REPL_ROLE, 'standalone'),
      this.settingsService.get(REPL_SLAVE_URL),
      this.settingsService.get(REPL_SLAVE_API_KEY),
      this.settingsService.get(REPL_MASTER_URL),
      this.settingsService.get(REPL_PEER_URL),
      this.settingsService.get(REPL_PEER_API_KEY),
      this.settingsService.getOrDefault(REPL_FULL_SYNC_CRON, '0 3 * * *'),
      this.settingsService.getOrDefault(REPL_PULL_CRON, '0 * * * *'),
      this.getOrCreateInstanceId(),
    ]);

    return {
      role: role as ReplicationConfig['role'],
      slaveUrl: slaveUrl || undefined,
      slaveApiKey: slaveApiKey ? '***' : undefined,
      masterUrl: masterUrl || undefined,
      peerUrl: peerUrl || undefined,
      peerApiKey: peerApiKey ? '***' : undefined,
      fullSyncCron: cron,
      pullCron,
      instanceId,
    };
  }

  @Put('config')
  async updateConfig(@Body() body: Partial<ReplicationConfig>): Promise<ReplicationConfig> {
    if (body.role && !['standalone', 'master', 'slave', 'peer'].includes(body.role)) {
      throw new BadRequestException('Invalid role');
    }
    if (body.role !== undefined) await this.settingsService.set(REPL_ROLE, body.role);
    if (body.slaveUrl !== undefined) await this.settingsService.set(REPL_SLAVE_URL, body.slaveUrl);
    if (body.slaveApiKey !== undefined && body.slaveApiKey !== '***') {
      await this.settingsService.set(REPL_SLAVE_API_KEY, body.slaveApiKey);
    }
    if (body.masterUrl !== undefined) await this.settingsService.set(REPL_MASTER_URL, body.masterUrl);
    if (body.peerUrl !== undefined) await this.settingsService.set(REPL_PEER_URL, body.peerUrl);
    if (body.peerApiKey !== undefined && body.peerApiKey !== '***') {
      await this.settingsService.set(REPL_PEER_API_KEY, body.peerApiKey);
    }
    if (body.fullSyncCron !== undefined) {
      // Validate FIRST so we don't persist a bad expression that the scheduler
      // would silently fail to apply on next restart. rescheduleFullSync throws
      // BadRequestException on invalid cron, which Nest maps to 400.
      this.scheduler.rescheduleFullSync(body.fullSyncCron);
      await this.settingsService.set(REPL_FULL_SYNC_CRON, body.fullSyncCron);
    }
    if (body.pullCron !== undefined) {
      this.scheduler.reschedulePull(body.pullCron);
      await this.settingsService.set(REPL_PULL_CRON, body.pullCron);
    }

    this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
    return this.getConfig();
  }

  // ── Status ───────────────────────────────────────

  @Get('status')
  async getStatus(): Promise<ReplicationStatus> {
    const [role, instanceId, lastSync, lastFullSync, lastPull] = await Promise.all([
      this.settingsService.getOrDefault(REPL_ROLE, 'standalone'),
      this.getOrCreateInstanceId(),
      this.settingsService.get(REPL_LAST_SYNC),
      this.settingsService.get(REPL_LAST_FULL_SYNC),
      this.settingsService.get(REPL_LAST_PULL),
    ]);

    const stats = await this.pushService.getQueueStats();

    // Test connectivity to the configured counterparty (slave for master, peer-peer)
    let connected = false;
    if (role === 'master' || role === 'peer') {
      const counterpartyUrl = role === 'peer'
        ? await this.settingsService.get(REPL_PEER_URL)
        : await this.settingsService.get(REPL_SLAVE_URL);
      const apiKey = role === 'peer'
        ? await this.settingsService.get(REPL_PEER_API_KEY)
        : await this.settingsService.get(REPL_SLAVE_API_KEY);
      if (counterpartyUrl) {
        try {
          await firstValueFrom(
            this.httpService.get(`${counterpartyUrl}/api/replication/status`, {
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
              timeout: 5000,
            }),
          );
          connected = true;
        } catch {
          connected = false;
        }
      }
    }

    return {
      role,
      instanceId,
      connected,
      lastSync,
      lastFullSync,
      lastPull,
      queueSize: stats.pending,
      failedCount: stats.failed,
    };
  }

  // ── Receive Endpoints (Slave) ────────────────────

  @Post('receive')
  @HttpCode(200)
  async receive(@Body() payload: ReplicationPayload) {
    const result = await this.receiveService.applyChange(payload);
    return result;
  }

  @Post('full-sync')
  @HttpCode(200)
  async receiveFullSync(@Body() projectExport: Record<string, unknown>) {
    const result = await this.receiveService.applyFullSync(projectExport);
    return result;
  }

  /**
   * Pull-side endpoint: serves a delta of changes since `since` for the requested
   * project IDs. Used by peers behind NAT/firewall (e.g. home instance) that can
   * push but cannot receive inbound. Server enforces per-project opt-in — projects
   * not flagged `replicationConfig.enabled=true` are silently dropped from the
   * response, even if the client asks for them.
   */
  @Get('pull')
  async pullChanges(
    @Query('since') since?: string,
    @Query('projectIds') projectIdsCsv?: string,
  ): Promise<ReplicationPullResponse> {
    const sinceDate = since ? new Date(since) : new Date(0);
    if (isNaN(sinceDate.getTime())) {
      throw new BadRequestException('Invalid `since` timestamp');
    }
    const requested = (projectIdsCsv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      return { changes: [], until: new Date().toISOString(), count: 0 };
    }

    const db = this.connection.db;
    if (!db) return { changes: [], until: new Date().toISOString(), count: 0 };

    const { ObjectId } = await import('mongodb');
    const requestedOids = requested.flatMap((id) => {
      try { return [new ObjectId(id)]; } catch { return []; }
    });

    // Server-side filter: only enabled projects, and only the ones the caller asked for.
    // This prevents leaking data from projects the client somehow shouldn't access.
    const enabledProjects = await db.collection('projects')
      .find({
        _id: { $in: requestedOids },
        'replicationConfig.enabled': true,
      })
      .toArray();

    const instanceId = await this.getOrCreateInstanceId();
    const until = new Date();
    const changes: ReplicationPayload[] = [];

    for (const project of enabledProjects) {
      const projectIdStr = String(project._id);
      const projectIdOid = project._id;

      // Project document itself if it changed
      if (project.updatedAt && new Date(project.updatedAt as Date | string) > sinceDate) {
        changes.push({
          event: { projectId: projectIdStr, entity: 'project', action: 'updated', entityId: projectIdStr },
          document: project as Record<string, unknown>,
          timestamp: until.toISOString(),
          sourceInstanceId: instanceId,
        });
      }

      for (const [entity, collName] of Object.entries(PULL_ENTITY_COLLECTIONS)) {
        if (changes.length >= PULL_MAX_DOCS) break;
        try {
          const docs = await db.collection(collName)
            .find({
              projectId: { $in: [projectIdOid, projectIdStr] },
              updatedAt: { $gt: sinceDate },
            })
            .sort({ updatedAt: 1 })
            .limit(PULL_MAX_DOCS - changes.length)
            .toArray();
          for (const doc of docs) {
            changes.push({
              event: {
                projectId: projectIdStr,
                entity,
                action: 'updated',
                entityId: String(doc._id),
              },
              document: doc as Record<string, unknown>,
              timestamp: until.toISOString(),
              sourceInstanceId: instanceId,
            });
          }
        } catch {
          // collection might not exist yet
        }
      }
      if (changes.length >= PULL_MAX_DOCS) break;
    }

    return {
      changes,
      until: until.toISOString(),
      count: changes.length,
    };
  }

  /** Trigger an inbound pull from the configured peer (manual UI button). */
  @Post('trigger-pull')
  @HttpCode(200)
  async triggerPull() {
    const result = await this.pullService.runPull();
    return result;
  }

  // ── Master Actions ───────────────────────────────

  @Post('test-connection')
  @HttpCode(200)
  async testConnection() {
    const role = await this.settingsService.get(REPL_ROLE);
    const counterpartyUrl = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_URL)
      : await this.settingsService.get(REPL_SLAVE_URL);
    const apiKey = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_API_KEY)
      : await this.settingsService.get(REPL_SLAVE_API_KEY);
    if (!counterpartyUrl) {
      throw new BadRequestException(
        role === 'peer' ? 'No peer URL configured' : 'No slave URL configured',
      );
    }

    const start = Date.now();
    try {
      await firstValueFrom(
        this.httpService.get(`${counterpartyUrl}/api/replication/status`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          timeout: 10000,
        }),
      );
      return { success: true, latency: Date.now() - start };
    } catch (err) {
      return { success: false, latency: Date.now() - start, error: (err as Error).message };
    }
  }

  @Post('trigger-full-sync')
  @HttpCode(200)
  async triggerFullSync(@Query('projectId') projectId?: string) {
    if (this.fullSyncService.isSyncing()) {
      return { started: false, reason: 'Already syncing' };
    }
    // Fire-and-forget. When projectId is present, only that single project
    // is synced — used by the per-project "Sync now" button in the UI and
    // by the auto-sync-on-enable flow.
    this.fullSyncService.runFullSync(projectId || undefined).catch(() => {});
    return { started: true, projectId: projectId || null };
  }

  @Post('queue/clear-failed')
  @HttpCode(200)
  async clearFailed() {
    const cleared = await this.pushService.clearFailed();
    return { cleared };
  }

  // ── Promote (Slave → Master) ─────────────────────

  @Post('promote')
  @HttpCode(200)
  async promote() {
    const role = await this.settingsService.get(REPL_ROLE);
    if (role !== 'slave') {
      throw new BadRequestException('Only a slave can be promoted');
    }
    await this.settingsService.set(REPL_ROLE, 'master');
    this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
    return { role: 'master', message: 'Instance promoted to master' };
  }

  // ── Helpers ──────────────────────────────────────

  private async getOrCreateInstanceId(): Promise<string> {
    let id = await this.settingsService.get(REPL_INSTANCE_ID);
    if (!id) {
      id = randomUUID();
      await this.settingsService.set(REPL_INSTANCE_ID, id);
    }
    return id;
  }
}
