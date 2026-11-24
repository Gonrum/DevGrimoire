import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * "Always allow" sent with an approval (IDE agent, ws_* only). Deliberately a
 * loose shape: `parseAgentAllowInput` validates it exactly like
 * `POST /workspaces/:id/agent-allow` and answers with a precise 400.
 */
export interface ResumeAlwaysAllowInput {
  kind?: unknown;
  match?: unknown;
  value?: unknown;
}

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

  /** Only with `approved: true` and only for ws_* calls; must cover the paused call. */
  @IsOptional()
  @IsObject()
  alwaysAllow?: ResumeAlwaysAllowInput;
}
