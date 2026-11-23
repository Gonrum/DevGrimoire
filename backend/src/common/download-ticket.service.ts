import { Global, Injectable, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** Lifetime of a download ticket. */
export const DOWNLOAD_TICKET_TTL_MS = 60_000;
/** Hard cap on live tickets so a flood of requests cannot grow the map without bound. */
const MAX_LIVE_TICKETS = 10_000;

export interface DownloadTicketBinding {
  workspaceId: string;
  path: string;
}

/** Who asked for the ticket: re-resolved (user, key, scope) when it is used. */
export interface DownloadTicketIdentity {
  /** `null` when authentication is disabled. */
  userId: string | null;
  apiKeyId?: string;
}

interface StoredTicket extends DownloadTicketBinding, DownloadTicketIdentity {
  expiresAt: number;
}

/**
 * Short-lived, single-use download tickets for the IDE (`fs/raw?ticket=`).
 *
 * A browser download is a plain navigation and cannot send a Bearer header, so
 * the client first asks for a ticket (authenticated as usual) and then
 * navigates to a URL carrying it. In memory on purpose: single backend node,
 * and a restart merely invalidates 60 s worth of tickets.
 */
@Injectable()
export class DownloadTicketService {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(
    private readonly ttlMs: number = DOWNLOAD_TICKET_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  issue(binding: DownloadTicketBinding, identity: DownloadTicketIdentity): string {
    this.prune();
    if (this.tickets.size >= MAX_LIVE_TICKETS) {
      // Drop the oldest entry (Map keeps insertion order).
      const oldest = this.tickets.keys().next();
      if (!oldest.done) this.tickets.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      workspaceId: binding.workspaceId,
      path: binding.path,
      userId: identity.userId,
      ...(identity.apiKeyId !== undefined ? { apiKeyId: identity.apiKeyId } : {}),
      expiresAt: this.now() + this.ttlMs,
    });
    return ticket;
  }

  private find(ticket: string, binding: DownloadTicketBinding): StoredTicket | null {
    this.prune();
    const stored = this.tickets.get(ticket);
    if (!stored) return null;
    if (stored.workspaceId !== binding.workspaceId || stored.path !== binding.path) return null;
    return stored;
  }

  /** Valid and bound to this workspace and path? Does not use the ticket up. */
  peek(ticket: string, binding: DownloadTicketBinding): boolean {
    return this.find(ticket, binding) !== null;
  }

  /** Uses the ticket up (single use). `null` when unknown, expired, used or bound elsewhere. */
  consume(ticket: string, binding: DownloadTicketBinding): DownloadTicketIdentity | null {
    const stored = this.find(ticket, binding);
    if (!stored) return null;
    this.tickets.delete(ticket);
    return {
      userId: stored.userId,
      ...(stored.apiKeyId !== undefined ? { apiKeyId: stored.apiKeyId } : {}),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, stored] of this.tickets) {
      if (stored.expiresAt <= now) this.tickets.delete(key);
    }
  }
}

@Global()
@Module({
  providers: [{ provide: DownloadTicketService, useFactory: () => new DownloadTicketService() }],
  exports: [DownloadTicketService],
})
export class DownloadTicketModule {}
