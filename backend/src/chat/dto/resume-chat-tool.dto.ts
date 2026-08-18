import { IsBoolean, IsString } from 'class-validator';

/**
 * Antwort auf eine Bestätigungsanfrage (T-415).
 *
 * `callId` ist Pflicht und wird gegen den gemerkten Aufruf geprüft: ohne diese
 * Prüfung könnte ein veralteter Client eine längst ersetzte Bestätigung
 * quittieren und damit ein Tool freigeben, das der Nutzer nie gesehen hat.
 */
export class ResumeChatToolDto {
  @IsString()
  callId: string;

  @IsBoolean()
  approved: boolean;
}
