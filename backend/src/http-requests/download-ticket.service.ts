import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ApiKey } from '../api-keys/schemas/api-key.schema';
import type { RequestUser } from '../common/request-context';

/**
 * One-time tickets for the streaming download (`GET requests/:id/download`,
 * a @Public route — the browser opens it as a plain link without auth header).
 *
 * Tickets used to be `EncryptionService.encrypt(JSON)`: same key and format as
 * secret values. Anyone able to create a secret whose plaintext is a ticket
 * JSON and read back its `encryptedValue` (project export with values) could
 * forge a ticket for any request id. Now a ticket is an opaque random handle;
 * the payload never leaves the server, so there is nothing to forge.
 *
 * The payload also carries the issuing actor. Redemption runs on a public
 * route without one, so the controller re-establishes it with
 * `RequestContext.run` — the request, environment and secret resolution are
 * then scope-checked as the issuing user (including API-key narrowing),
 * instead of running as a trusted internal caller.
 *
 * In-memory like the previous single-use registry: a ticket lives 60 s and
 * is redeemed by the instance that issued it.
 */

interface TicketPayload {
  requestId: string;
  environmentId: string | null;
  actor: RequestUser;
  apiKey?: ApiKey;
  exp: number;
}

export interface RedeemedTicket {
  environmentId?: string;
  actor: RequestUser;
  apiKey?: ApiKey;
}

const TTL_MS = 60_000;
/** Upper bound so a flood of mint calls cannot grow the map without limit. */
const MAX_OPEN_TICKETS = 10_000;

@Injectable()
export class DownloadTicketService {
  private readonly open = new Map<string, TicketPayload>();

  mint(input: { requestId: string; environmentId?: string; actor: RequestUser; apiKey?: ApiKey }): string {
    this.prune();
    if (this.open.size >= MAX_OPEN_TICKETS) {
      throw new UnauthorizedException('Zu viele offene Download-Tickets');
    }
    const ticket = randomBytes(32).toString('base64url');
    this.open.set(ticket, {
      requestId: input.requestId,
      environmentId: input.environmentId ?? null,
      actor: input.actor,
      apiKey: input.apiKey,
      exp: Date.now() + TTL_MS,
    });
    return ticket;
  }

  verifyAndConsume(ticket: unknown, requestId: string): RedeemedTicket {
    if (typeof ticket !== 'string' || ticket.length === 0) {
      throw new UnauthorizedException('Ungültiges Download-Ticket');
    }
    const payload = this.open.get(ticket);
    if (!payload) {
      // Unknown, already used, or expired and pruned — indistinguishable on purpose.
      throw new UnauthorizedException('Ungültiges oder bereits verwendetes Download-Ticket');
    }
    if (payload.requestId !== requestId) {
      // Not consumed: a mismatched id must not burn someone else's ticket.
      throw new UnauthorizedException('Download-Ticket passt nicht zu diesem Request');
    }
    this.open.delete(ticket);
    if (Date.now() > payload.exp) {
      throw new UnauthorizedException('Download-Ticket abgelaufen');
    }
    return { environmentId: payload.environmentId ?? undefined, actor: payload.actor, apiKey: payload.apiKey };
  }

  private prune(): void {
    const now = Date.now();
    for (const [ticket, payload] of this.open) {
      if (payload.exp < now) this.open.delete(ticket);
    }
  }
}
