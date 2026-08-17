import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../common/narrow';
import { EncryptionService } from '../common/encryption.service';

interface TicketPayload {
  purpose: 'wk-download';
  requestId: string;
  environmentId: string | null;
  userId: string;
  exp: number;
  jti: string;
}

/**
 * Form eines entschlüsselten Tickets, wie sie `readTicketShape` garantiert:
 * jedes Feld hat den richtigen *Typ*, aber `purpose` ist noch nicht auf den
 * erwarteten Wert geprüft — das bleibt eine inhaltliche Prüfung in
 * `verifyAndConsume` (mit eigener Fehlermeldung).
 */
interface TicketShape {
  purpose: string;
  requestId: string;
  environmentId: string | null;
  userId: string;
  exp: number;
  jti: string;
}

/**
 * Liest ein entschlüsseltes Ticket. Vorher stand hier
 * `JSON.parse(...) as TicketPayload` — eine Behauptung über Fremddaten.
 *
 * `exp` und `jti` waren unten schon einzeln geprüft (`Number.isFinite`,
 * `typeof === 'string'`), die Ablauf- und Einmal-Prüfung war also nicht offen.
 * Ungeprüft blieben `userId` und `environmentId`: ein Ticket mit
 * `environmentId: 5` lief bis in `openStream` durch und fiel erst beim
 * Environment-Lookup auf, `userId` wurde in beliebigem Typ zurückgegeben.
 * Diese Funktion prüft jetzt alle Felder an einer Stelle; die inhaltlichen
 * Prüfungen (passt das Ticket zum Request, ist es abgelaufen, war es schon
 * verbraucht) bleiben unverändert dort, wo sie ihre eigene Meldung haben.
 */
function readTicketShape(json: unknown): TicketShape {
  if (!isRecord(json)) throw new Error('ticket payload is not an object');
  const { purpose, requestId, environmentId, userId, exp, jti } = json;
  if (
    typeof purpose !== 'string' ||
    typeof requestId !== 'string' ||
    typeof userId !== 'string' ||
    typeof jti !== 'string' ||
    typeof exp !== 'number' ||
    (environmentId !== null && typeof environmentId !== 'string')
  ) {
    throw new Error('ticket payload has unexpected shape');
  }
  return { purpose, requestId, environmentId, userId, exp, jti };
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
    let payload: TicketShape;
    try {
      const parsed: unknown = JSON.parse(this.enc.decrypt(ticket));
      payload = readTicketShape(parsed);
    } catch {
      throw new UnauthorizedException('Ungültiges Download-Ticket');
    }
    if (payload.purpose !== 'wk-download' || payload.requestId !== requestId) {
      throw new UnauthorizedException('Download-Ticket passt nicht zu diesem Request');
    }
    // `jti`/`exp` haben nach `readTicketShape` garantiert den richtigen Typ;
    // `Number.isFinite` bleibt nötig, weil `NaN`/`Infinity` typmäßig `number`
    // sind und `Date.now() > NaN` false ergäbe — ein unbegrenzt gültiges Ticket.
    if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
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
