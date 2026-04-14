import {
  Controller, Get, Post, Put, Patch, Param, Body, HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationReceiveService } from './replication-receive.service';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_MASTER_URL, REPL_PEER_URL, REPL_PEER_API_KEY,
  REPL_LAST_SYNC, REPL_LAST_FULL_SYNC,
  REPL_FULL_SYNC_CRON, REPL_INSTANCE_ID,
  ReplicationPayload, ReplicationConfig, ReplicationStatus,
} from './replication.constants';
import { randomUUID } from 'crypto';

@Controller('replication')
export class ReplicationController {
  constructor(
    private receiveService: ReplicationReceiveService,
    private pushService: ReplicationPushService,
    private fullSyncService: ReplicationFullSyncService,
    private settingsService: SettingsService,
    private projectsService: ProjectsService,
    private httpService: HttpService,
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

  // ── Config CRUD ──────────────────────────────────

  @Get('config')
  async getConfig(): Promise<ReplicationConfig> {
    const [role, slaveUrl, slaveApiKey, masterUrl, peerUrl, peerApiKey, cron, instanceId] = await Promise.all([
      this.settingsService.getOrDefault(REPL_ROLE, 'standalone'),
      this.settingsService.get(REPL_SLAVE_URL),
      this.settingsService.get(REPL_SLAVE_API_KEY),
      this.settingsService.get(REPL_MASTER_URL),
      this.settingsService.get(REPL_PEER_URL),
      this.settingsService.get(REPL_PEER_API_KEY),
      this.settingsService.getOrDefault(REPL_FULL_SYNC_CRON, '0 3 * * *'),
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
    if (body.fullSyncCron !== undefined) await this.settingsService.set(REPL_FULL_SYNC_CRON, body.fullSyncCron);

    return this.getConfig();
  }

  // ── Status ───────────────────────────────────────

  @Get('status')
  async getStatus(): Promise<ReplicationStatus> {
    const [role, instanceId, lastSync, lastFullSync] = await Promise.all([
      this.settingsService.getOrDefault(REPL_ROLE, 'standalone'),
      this.getOrCreateInstanceId(),
      this.settingsService.get(REPL_LAST_SYNC),
      this.settingsService.get(REPL_LAST_FULL_SYNC),
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
  async triggerFullSync() {
    if (this.fullSyncService.isSyncing()) {
      return { started: false, reason: 'Already syncing' };
    }
    // Fire-and-forget
    this.fullSyncService.runFullSync().catch(() => {});
    return { started: true };
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
