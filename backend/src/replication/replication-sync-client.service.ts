import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from '../settings/settings.service';
import {
  SyncLogEntry,
  SyncReceiveResponse,
  SyncPullResponse,
} from './replication-sync.types';
import { REPL_PEER_URL, REPL_PEER_API_KEY } from './replication.constants';

/**
 * HTTP client for the log-based sync engine. Calls the PEER's sync endpoints
 * (POST /sync/receive, GET /sync/pull) using the configured peer URL + API key.
 * Only the active driver (home) uses this; the passive side just serves.
 * Throws on missing peer URL or HTTP failure — the caller (driver) treats that
 * as transient and leaves its cursor unchanged for the next cycle to retry.
 */
@Injectable()
export class ReplicationSyncClientService {
  private readonly logger = new Logger(ReplicationSyncClientService.name);

  constructor(
    private settingsService: SettingsService,
    private httpService: HttpService,
  ) {}

  private async peer(): Promise<{ url: string; apiKey: string | null }> {
    const url = await this.settingsService.get(REPL_PEER_URL);
    if (!url) throw new Error('No peer URL configured');
    const apiKey = await this.settingsService.get(REPL_PEER_API_KEY);
    return { url: url.replace(/\/+$/, ''), apiKey };
  }

  private headers(apiKey: string | null): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /** Push a batch to the peer's /sync/receive. */
  async pushReceive(
    sourceInstanceId: string,
    entries: SyncLogEntry[],
  ): Promise<SyncReceiveResponse> {
    const { url, apiKey } = await this.peer();
    const res = await firstValueFrom(
      this.httpService.post<SyncReceiveResponse>(
        `${url}/api/replication/sync/receive`,
        { sourceInstanceId, entries },
        { headers: this.headers(apiKey), timeout: 60000 },
      ),
    );
    return res.data;
  }

  /** Pull a page from the peer's /sync/pull. */
  async pullFrom(since: number, limit: number): Promise<SyncPullResponse> {
    const { url, apiKey } = await this.peer();
    const res = await firstValueFrom(
      this.httpService.get<SyncPullResponse>(
        `${url}/api/replication/sync/pull?since=${since}&limit=${limit}`,
        { headers: this.headers(apiKey), timeout: 60000 },
      ),
    );
    return res.data;
  }
}
