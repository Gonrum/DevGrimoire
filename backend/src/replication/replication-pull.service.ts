import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { REPLICATION_STATUS_CHANGED } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationReceiveService } from './replication-receive.service';
import {
  REPL_ROLE,
  REPL_PEER_URL,
  REPL_PEER_API_KEY,
  REPL_LAST_PULL,
  RECEIVING_ROLES,
  ReplicationRole,
  ReplicationPullResponse,
} from './replication.constants';

/**
 * Inbound pull worker for asymmetric topologies. Use case: the local instance
 * sits behind NAT/firewall and the remote peer cannot push to it. We poll the
 * peer's `GET /api/replication/pull` endpoint periodically and apply the
 * returned delta locally via the existing applyChange path (which already
 * runs the LWW + per-project filter checks).
 *
 * Lives only for `peer` role today — `slave` could in theory also pull from
 * its master, but that's a separate use case.
 */
@Injectable()
export class ReplicationPullService {
  private readonly logger = new Logger(ReplicationPullService.name);
  private pulling = false;

  constructor(
    private settingsService: SettingsService,
    private projectsService: ProjectsService,
    private receiveService: ReplicationReceiveService,
    private httpService: HttpService,
    private eventEmitter: EventEmitter2,
  ) {}

  /** True while a pull is in flight — used by scheduler to avoid overlap. */
  isPulling(): boolean {
    return this.pulling;
  }

  /**
   * Run one pull round. Returns counts so the controller / scheduler can log
   * sensibly. Iterates the response in pages: if the server returned exactly
   * `count == limit` docs it might have more, so we re-pull immediately with
   * the latest `until` as new `since` until count drops below the limit.
   */
  async runPull(): Promise<{ pulled: number; applied: number; skipped: number; rounds: number; error?: string }> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (!role || !RECEIVING_ROLES.has(role) || role !== 'peer') {
      // Pull is currently only meaningful for peer role; slaves receive pushes.
      return { pulled: 0, applied: 0, skipped: 0, rounds: 0, error: 'Pull only runs in peer role' };
    }
    if (this.pulling) {
      return { pulled: 0, applied: 0, skipped: 0, rounds: 0, error: 'Pull already in progress' };
    }

    const peerUrl = await this.settingsService.get(REPL_PEER_URL);
    const apiKey = await this.settingsService.get(REPL_PEER_API_KEY);
    if (!peerUrl) {
      return { pulled: 0, applied: 0, skipped: 0, rounds: 0, error: 'No peer URL configured' };
    }

    this.pulling = true;
    let totalPulled = 0;
    let totalApplied = 0;
    let totalSkipped = 0;
    let rounds = 0;

    try {
      // Build the list of locally-enabled projects. We only ask the peer for
      // projects we ourselves have flagged for replication — symmetric to the
      // server-side enabled-filter, prevents pulling stuff we don't want.
      const enabledIds = await this.getEnabledProjectIds();
      if (enabledIds.length === 0) {
        this.logger.debug('Pull skipped: no enabled projects locally');
        return { pulled: 0, applied: 0, skipped: 0, rounds: 0 };
      }

      let since = (await this.settingsService.get(REPL_LAST_PULL)) || new Date(0).toISOString();
      const SAFETY_MAX_ROUNDS = 20; // hard cap so a runaway server can't loop us forever

      while (rounds < SAFETY_MAX_ROUNDS) {
        rounds++;
        const url = `${peerUrl}/api/replication/pull?since=${encodeURIComponent(since)}&projectIds=${enabledIds.join(',')}`;
        let response: ReplicationPullResponse;
        try {
          const res = await firstValueFrom(
            this.httpService.get<ReplicationPullResponse>(url, {
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
              timeout: 60000,
            }),
          );
          response = res.data;
        } catch (err) {
          this.logger.warn(`Pull HTTP failed: ${(err as Error).message}`);
          return {
            pulled: totalPulled, applied: totalApplied, skipped: totalSkipped, rounds,
            error: (err as Error).message,
          };
        }

        const changes = Array.isArray(response.changes) ? response.changes : [];
        totalPulled += changes.length;

        for (const payload of changes) {
          try {
            const result = await this.receiveService.applyChange(payload);
            if (result.applied) totalApplied++;
            else totalSkipped++;
          } catch (err) {
            this.logger.warn(`Pull apply failed for ${payload.event.entity}/${payload.event.entityId}: ${(err as Error).message}`);
            totalSkipped++;
          }
        }

        // Persist the cursor — `until` is the server's clock at the moment of
        // response, so the next poll resumes exactly where this left off.
        if (response.until) {
          await this.settingsService.set(REPL_LAST_PULL, response.until);
          since = response.until;
          this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
        }

        // If the server returned fewer than its hard limit, we're caught up.
        // (The endpoint caps at PULL_MAX_DOCS=500; less than that means there
        //  was nothing more pending.)
        if (changes.length < 500) break;
      }

      this.logger.log(
        `Pull complete: ${totalPulled} pulled, ${totalApplied} applied, ${totalSkipped} skipped over ${rounds} round(s)`,
      );
      return { pulled: totalPulled, applied: totalApplied, skipped: totalSkipped, rounds };
    } finally {
      this.pulling = false;
    }
  }

  /** Project IDs locally flagged `replicationConfig.enabled=true`. Read once
   *  per pull-round; cached projects on the server-side enforce the same filter. */
  private async getEnabledProjectIds(): Promise<string[]> {
    const all = await this.projectsService.findAll(true);
    return all
      .filter((p) => (p as unknown as { replicationConfig?: { enabled?: boolean } }).replicationConfig?.enabled === true)
      .map((p) => p._id.toString());
  }
}
