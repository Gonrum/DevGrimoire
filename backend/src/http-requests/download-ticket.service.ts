import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EncryptionService } from '../common/encryption.service';

interface TicketPayload {
  purpose: 'wk-download';
  requestId: string;
  environmentId: string | null;
  userId: string;
  exp: number;
  jti: string;
}

const TTL_MS = 60_000;

@Injectable()
export class DownloadTicketService {
  private readonly consumed = new Map<string, number>();

  constructor(private readonly enc: EncryptionService) {}

  mint(input: { requestId: string; environmentId?: string; userId: string }): string {
    const payload: TicketPayload = {
      purpose: 'wk-download',
      requestId: input.requestId,
      environmentId: input.environmentId ?? null,
      userId: input.userId,
      exp: Date.now() + TTL_MS,
      jti: randomUUID(),
    };
    return this.enc.encrypt(JSON.stringify(payload));
  }

  verifyAndConsume(ticket: string, requestId: string): { environmentId?: string; userId: string } {
    let payload: TicketPayload;
    try {
      payload = JSON.parse(this.enc.decrypt(ticket)) as TicketPayload;
    } catch {
      throw new UnauthorizedException('Ungültiges Download-Ticket');
    }
    if (payload.purpose !== 'wk-download' || payload.requestId !== requestId) {
      throw new UnauthorizedException('Download-Ticket passt nicht zu diesem Request');
    }
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      throw new UnauthorizedException('Download-Ticket abgelaufen');
    }
    if (this.consumed.has(payload.jti)) {
      throw new UnauthorizedException('Download-Ticket bereits verwendet');
    }
    this.consumed.set(payload.jti, payload.exp);
    this.prune();
    return { environmentId: payload.environmentId ?? undefined, userId: payload.userId };
  }

  private prune(): void {
    const now = Date.now();
    for (const [jti, exp] of this.consumed) {
      if (exp < now) this.consumed.delete(jti);
    }
  }
}
