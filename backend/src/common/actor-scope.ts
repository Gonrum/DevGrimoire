import type { ScopeMode } from './permissions';
import type { RequestUser } from './request-context';

/**
 * Aufbau des `RequestUser`-Actors aus seinen Quellen.
 *
 * Warum das eine eigene Datei ist: dieselbe Verengungslogik wurde an drei
 * Stellen gebraucht, stand aber nur in einer. `JwtAuthGuard` baute den Actor
 * vollständig (Scope-Achsen, Permissions, `apiKeyId`), während die
 * MCP-Middleware in `main.ts` nur `userId`/`username`/`role` setzte — unter dem
 * Kommentar „Mirror JwtAuthGuard pattern so RequestContext + per-user scoped
 * tools work". Gespiegelt war damit aber nur die Hälfte.
 *
 * Die Folge war kein kleiner Schönheitsfehler: `actorCanAccessProject()` macht
 * `actor.projectScopeMode ?? 'all'`, ein Actor ohne das Feld ist also
 * uneingeschränkt. Ein API-Key, der bewusst auf `projectScopeMode: 'allowlist'`
 * oder `'none'` verengt wurde, war über `/mcp`, `/sse` und `/messages`
 * vollständig offen — inklusive `secret_get`, das Klartextwerte liefert. Und
 * weil MCP-Tools prompt-gesteuert sind, ist das zugleich der Weg, auf dem ein
 * injizierter Agent an die Credentials anderer Projekte kommt.
 *
 * Die Funktionen hier sind rein und nehmen strukturelle Typen, damit sie mit
 * `User` wie `UserDocument` und `ApiKey` wie `ApiKeyDocument` funktionieren,
 * ohne Mongoose-Typen in `common/` zu ziehen.
 */

/** ObjectId-artig — `toString()` ist die einzige benötigte Operation. */
export interface IdLike {
  toString(): string;
}

/** Die Scope-/Permission-Felder, wie sie auf `User` und `ApiKey` vorkommen. */
export interface ScopeSource {
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: IdLike[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: IdLike[];
}

/** Wirksamer Scope nach der Verengung. */
export interface NarrowedScope {
  mode: ScopeMode;
  ids: string[];
}

/** `ObjectId[]` → `string[]`. `undefined` wird zur leeren Liste, nicht zu `undefined`. */
export function idsToStrings(ids: readonly IdLike[] | undefined): string[] {
  if (!ids) return [];
  return ids.map((id) => id.toString());
}

export function intersectIds(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((id) => b.includes(id));
}

/**
 * Verbindet den Scope eines API-Keys mit dem seines Besitzers. Ein Key kann
 * nur verengen, nie erweitern: `mode` fällt für Altbestände ohne Scope-Felder
 * auf `'all'` zurück, und ein `'none'` auf beiden Seiten gewinnt immer.
 *
 * Konkret: hat der Nutzer `projectScopeMode='allowlist'` mit 5 Ids und der Key
 * `'all'`, bleiben es die 5 Ids des Nutzers. Siehe Knowledge-Eintrag T-210.
 */
export function narrowScope(
  keyMode: ScopeMode | undefined,
  keyIds: readonly string[],
  ownerMode: ScopeMode | undefined,
  ownerIds: readonly string[],
): NarrowedScope {
  const km = keyMode || 'all';
  const om = ownerMode || 'all';
  if (km === 'none' || om === 'none') return { mode: 'none', ids: [] };
  if (km === 'all' && om === 'all') return { mode: 'all', ids: [] };
  if (km === 'all') return { mode: 'allowlist', ids: [...ownerIds] };
  if (om === 'all') return { mode: 'allowlist', ids: [...keyIds] };
  return { mode: 'allowlist', ids: intersectIds(keyIds, ownerIds) };
}

/**
 * Scope-/Permission-Anteil eines Actors aus einem `User`-Datensatz.
 *
 * `|| 'all'` statt `?? 'all'` ist absichtlich die bisherige Semantik aus
 * `JwtAuthGuard`: Dokumente von vor T-221 haben die Felder gar nicht, und für
 * die soll sich am Zugriff nichts ändern.
 */
export function scopeFromUser(user: ScopeSource) {
  return {
    permissions: user.permissions || [],
    projectScopeMode: user.projectScopeMode || 'all',
    allowedProjectIds: idsToStrings(user.allowedProjectIds),
    customerScopeMode: user.customerScopeMode || 'all',
    allowedCustomerIds: idsToStrings(user.allowedCustomerIds),
  };
}

/**
 * Voller Actor für einen API-Key-Aufruf: Key-Scope ∩ Besitzer-Scope.
 *
 * Permissions: die Admin-Rolle umgeht die Liste ohnehin
 * (`actorHasPermission`). Für Nicht-Admins ist die wirksame Menge der
 * Schnittmenge aus Key und Besitzer; ein leerer `key.permissions` fällt auf die
 * des Besitzers zurück (Altbestand ohne Permission-Feld).
 */
export function actorFromApiKey(
  apiKey: { _id: IdLike; userId: IdLike } & ScopeSource,
  owner: { username: string; role: string } & ScopeSource,
): RequestUser {
  const proj = narrowScope(
    apiKey.projectScopeMode,
    idsToStrings(apiKey.allowedProjectIds),
    owner.projectScopeMode,
    idsToStrings(owner.allowedProjectIds),
  );
  const cust = narrowScope(
    apiKey.customerScopeMode,
    idsToStrings(apiKey.allowedCustomerIds),
    owner.customerScopeMode,
    idsToStrings(owner.allowedCustomerIds),
  );
  const ownerPerms = owner.permissions || [];
  const keyPerms = apiKey.permissions || [];
  return {
    userId: apiKey.userId.toString(),
    username: owner.username,
    role: owner.role,
    apiKeyId: apiKey._id.toString(),
    permissions: keyPerms.length === 0 ? [...ownerPerms] : intersectIds(keyPerms, ownerPerms),
    projectScopeMode: proj.mode,
    allowedProjectIds: proj.ids,
    customerScopeMode: cust.mode,
    allowedCustomerIds: cust.ids,
  };
}

/**
 * Voller Actor für einen Aufruf ohne API-Key — also ein JWT.
 *
 * Gebraucht von den WebSocket-Upgrade-Handlern in `main.ts`: die laufen
 * vollständig ausserhalb der Nest-Pipeline, `JwtAuthGuard` greift dort nie. Sie
 * prüfen die JWT-Signatur selbst und hatten danach nur die drei Felder aus dem
 * Token (`sub`/`username`/`role`). Der Scope steht aber nicht im Token, sondern
 * in der Datenbank — deshalb laden beide Handler den Nutzer jetzt nach.
 */
export function actorFromUser(user: { _id: IdLike; username: string; role: string } & ScopeSource): RequestUser {
  return {
    userId: user._id.toString(),
    username: user.username,
    role: user.role,
    ...scopeFromUser(user),
  };
}
