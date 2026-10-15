import { isRecord } from './narrow';

/**
 * Token-Arten, die mit `JWT_SECRET` signiert werden, und wie man sie
 * auseinanderhält.
 *
 * Nutzer-Access-Tokens und die dg-CLI-Tokens aus dem Workspace-Terminal teilen
 * sich das Secret. Vorher trug keines einen Typ: ein dg-Token im
 * `Authorization`-Header lief bis in die Nutzer-Nachladung und scheiterte dort
 * nur, weil sein `sub` keine ObjectId ist (CastError) — Ablehnung aus Zufall.
 * Jetzt verlangt jeder Prüfer seinen Typ.
 */

/** Ausdrücklich festgelegt, statt sich auf den Default der Bibliothek zu verlassen. */
export const JWT_ALGORITHM = 'HS256';

export const ACCESS_TOKEN_TYPE = 'access';
export const DG_CLI_TOKEN_TYPE = 'dg-cli';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Nutzer-Id aus einem verifizierten Payload — nur, wenn es ein Access-Token
 * ist und `sub` eine Nutzer-Id sein kann. Sonst `null`.
 */
export function accessTokenUserId(payload: unknown): string | null {
  if (!isRecord(payload) || payload.typ !== ACCESS_TOKEN_TYPE) return null;
  return typeof payload.sub === 'string' && OBJECT_ID.test(payload.sub) ? payload.sub : null;
}
