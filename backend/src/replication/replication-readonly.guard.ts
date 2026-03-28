import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { REPL_ROLE } from './replication.constants';

@Injectable()
export class ReplicationReadonlyGuard implements CanActivate {
  private cachedRole: string | null = null;
  private cacheExpiry = 0;

  constructor(private settingsService: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const role = await this.getRole();
    if (role !== 'slave') return true;

    const request = context.switchToHttp().getRequest();
    const method = request.method?.toUpperCase();

    // Allow all read operations
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const url = request.url as string;

    // Allow replication endpoints
    if (url.startsWith('/api/replication') || url.startsWith('/replication')) return true;

    // Allow auth endpoints (login must work)
    if (url.startsWith('/api/auth') || url.startsWith('/auth')) return true;

    throw new ForbiddenException('Instance is in read-only slave mode');
  }

  private async getRole(): Promise<string> {
    const now = Date.now();
    if (this.cachedRole !== null && now < this.cacheExpiry) {
      return this.cachedRole;
    }
    this.cachedRole = (await this.settingsService.get(REPL_ROLE)) || 'standalone';
    this.cacheExpiry = now + 10_000; // 10 second TTL
    return this.cachedRole;
  }

  /** Force cache invalidation (called after role change) */
  invalidateCache(): void {
    this.cachedRole = null;
    this.cacheExpiry = 0;
  }
}
