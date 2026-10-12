import { randomBytes } from 'node:crypto';

let fallback: string | null = null;

/**
 * Das JWT-Secret für alle drei Stellen, die eines brauchen (AuthModule,
 * JwtStrategy, WorkspacesModule).
 *
 * Vorher fiel jede Stelle bei fehlendem JWT_SECRET auf den im Repo
 * öffentlichen String `'dev-only-auth-disabled'` zurück (H-3). Mit
 * deaktivierter Auth ist das für die REST-Pfade egal — nicht aber für den
 * WorkspaceCliGuard: der verifizierte dg-CLI-Tokens weiter gegen dieses
 * Secret, jeder konnte also selbst welche signieren.
 *
 * Jetzt: ohne JWT_SECRET ein zufälliges Secret pro Prozess, einmal erzeugt
 * und für alle Aufrufer identisch (die drei JwtModule-Instanzen müssen
 * dieselben Tokens akzeptieren). Tokens überleben dann keinen Neustart —
 * genau richtig für den Modus ohne Auth. Mit aktivierter Auth bleibt
 * JWT_SECRET Pflicht (AuthModule wirft).
 */
export function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;
  if (!fallback) fallback = randomBytes(48).toString('hex');
  return fallback;
}
