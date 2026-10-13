import { HttpException } from '@nestjs/common';
import { isRecord } from './common/narrow';
import { redactValue } from './workflows/workflow-redaction';

/** Obergrenze für eine Fehlermeldung, die einen MCP-Aufrufer erreicht. */
export const MCP_ERROR_MAX_CHARS = 1000;

const MONGO_UNAVAILABLE = new Set([
  'MongoNetworkError', 'MongoServerSelectionError', 'MongoTopologyClosedError',
  'MongoNotConnectedError', 'MongoNetworkTimeoutError',
]);

/**
 * URLs auf Herkunft und Pfad kürzen: Query-String und Benutzerdaten können
 * Tokens tragen (`request_send` gegen `…?access_token=…`, `https://user:pass@…`).
 */
function stripUrlSecrets(text: string): string {
  return text.replace(/\b(https?|wss?):\/\/[^\s'"<>)]+/gi, (raw) => {
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      return raw.replace(/\?.*$/, '?…');
    }
  });
}

function nameOf(err: unknown): string {
  return isRecord(err) && typeof err.name === 'string' ? err.name : '';
}

/**
 * Was ein MCP-Aufrufer von einem geworfenen Fehler sieht (M-49).
 *
 * Vorher ging `error.message` unverändert hinaus — für ~266 Tools durch einen
 * einzigen Catch-All. Das waren Mongoose-Meldungen mit Collection-Namen und
 * Filterinhalten, Treiberfehler mit Topologie-Details und undici-Meldungen
 * mit der vollen Ziel-URL samt Query-String.
 *
 * - Nest-`HttpException`s sind bewusst formulierte Meldungen der Services
 *   (404 „… nicht gefunden", 400 mit Validierungstext) und bleiben lesbar.
 * - Datenbank- und Validierungsfehler werden auf eine stabile Kurzform
 *   gebracht, ohne Werte.
 * - Alles andere geht durch: URLs ohne Query/Userinfo, Credential-Muster
 *   geschwärzt, gekappt. Tools werfen absichtlich sprechende `Error`s
 *   (`requireString`, `cluster_identifier_required`, …) — die zu verstecken,
 *   wäre für den Agenten schlimmer als das Restrisiko.
 *
 * Das Original geht über `log` ins Server-Log, damit beim Debuggen nichts fehlt.
 */
export function mcpErrorMessage(error: unknown): string {
  const name = nameOf(error);
  let message: string;
  if (error instanceof HttpException) {
    message = error.message;
  } else if (name === 'CastError') {
    const path = isRecord(error) && typeof error.path === 'string' ? error.path : 'id';
    message = `invalid_id: ${path} ist keine gültige Id`;
  } else if (name === 'ValidationError' && isRecord(error) && isRecord(error.errors)) {
    message = `validation_failed: ${Object.keys(error.errors).join(', ')}`;
  } else if (isRecord(error) && error.code === 11000) {
    message = 'duplicate: ein Eintrag mit diesem Schlüssel existiert bereits';
  } else if (MONGO_UNAVAILABLE.has(name)) {
    message = 'database_unavailable: Datenbank nicht erreichbar';
  } else if (name.startsWith('Mongo')) {
    message = 'database_error: Datenbankfehler (Details im Server-Log)';
  } else {
    message = error instanceof Error ? error.message : String(error);
  }
  return redactValue(stripUrlSecrets(message), { maxStringLength: MCP_ERROR_MAX_CHARS });
}
