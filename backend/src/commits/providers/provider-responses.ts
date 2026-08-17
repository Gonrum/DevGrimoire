/**
 * Antwort-Formen der drei Git-Hosts (GitHub, GitLab, Gitea).
 *
 * Grundsätze für diese Datei:
 *
 * 1. **Nur benutzte Felder.** Hier steht kein vollständiges API-Modell, sondern
 *    genau das, was die Provider auslesen. Alles andere ignorieren wir.
 * 2. **Alles optional.** Fremde Hosts lassen Felder unangekündigt weg (alte
 *    Gitea-Versionen, GitLab-Selfhost-Stände, GitHub-Enterprise). Ein als
 *    pflichtig deklariertes Feld, das der Host nicht liefert, tauscht ein
 *    Lint-Finding gegen einen Laufzeitfehler — deshalb ist hier auch das
 *    optional, was die APIs als "always present" dokumentieren. Wo der
 *    Normalisierungs-Code einen Wert *braucht* (sha, tag_name, Datum), prüft er
 *    ihn selbst und überspringt den Datensatz statt `undefined` weiterzugeben.
 * 3. **Gemeinsames einmal.** Gitea spiegelt die GitHub-API bewusst nach, daher
 *    teilen sich beide die `GitHubStyle*`-Typen; GitLab hat eine eigene Form.
 * 4. **Fehler-Payloads werden nicht geparst.** Alle drei Hosts antworten im
 *    Fehlerfall mit einem *Objekt* (`{ message, ... }`) statt der erwarteten
 *    Liste. Die Provider werten ausschließlich den HTTP-Status aus und werfen;
 *    den Body lesen sie nicht. Deshalb gibt es hier absichtlich keinen
 *    Error-Typ — es gibt keine Stelle, die ihn benutzen würde. Die
 *    Form-Unterscheidung "Liste vs. Objekt" passiert zur Laufzeit in
 *    `readJsonArray` / `readJsonObject`.
 */

/**
 * `Array.isArray()` auf einem `unknown` verengt in TypeScript zu `any[]` und
 * holt damit die ganze `no-unsafe-*`-Kaskade auf den Elementen zurück. Dieses
 * Prädikat verengt zu `unknown[]` — Elemente bleiben unbekannt, bis sie geprüft
 * oder typisiert sind.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Liest einen JSON-Body und gibt ihn als Liste von `T` zurück — oder `null`,
 * wenn der Host keine Liste geschickt hat (Fehler-Objekt, HTML-Proxy-Seite,
 * `{ message: ... }`).
 *
 * Hier steht die **einzige** Typ-Behauptung der Provider-Schicht (zusammen mit
 * `readJsonObject`). Sie ist unvermeidbar: `response.json()` liefert per
 * Definition `any`, und kein Typsystem kann die Form der Antwort eines fremden
 * Servers kennen. Zwei Dinge machen sie vertretbar:
 *
 * - Die Laufzeitprüfung davor stellt sicher, dass es überhaupt eine Liste ist.
 * - Die `T`-Interfaces deklarieren jedes Host-Feld optional. Die Behauptung
 *   sagt also nur "Objekte mit möglicherweise diesen Feldern" — sie kann nicht
 *   die Existenz eines Feldes vortäuschen, das der Host weggelassen hat.
 *
 * Ein `JSON.parse`-Fehler (z.B. HTML-Fehlerseite eines Reverse Proxy) fliegt
 * bewusst weiter nach oben, statt als leere Liste getarnt zu werden.
 */
export async function readJsonArray<T>(response: Response): Promise<T[] | null> {
  const body: unknown = await response.json();
  if (!isUnknownArray(body)) return null;
  return body as T[];
}

/**
 * Gegenstück zu `readJsonArray` für Endpunkte, die ein einzelnes Objekt
 * liefern (Einzel-Commit, Repo-Metadaten). `null`, wenn die Antwort kein
 * Objekt ist — Listen zählen hier ausdrücklich nicht als Objekt.
 */
export async function readJsonObject<T extends object>(
  response: Response,
): Promise<T | null> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || isUnknownArray(body)) return null;
  return body as T;
}

// ---------------------------------------------------------------------------
// Gemeinsame Bausteine
// ---------------------------------------------------------------------------

/** GitHub/Gitea `git-user`: Autor/Committer *im Commit* (nicht der Host-User). */
export interface GitHubStyleGitUser {
  name?: string;
  email?: string;
  date?: string;
}

/**
 * Additions/Deletions. Bei GitHub und Gitea nur am Einzel-Commit-Endpunkt
 * vorhanden, bei GitLab zusätzlich in der Liste (`with_stats=true`).
 */
export interface CommitStatsBlock {
  additions?: number;
  deletions?: number;
}

/** Alle drei Hosts liefern Branches als Liste mit mindestens einem Namen. */
export interface BranchResponse {
  name?: string;
}

/**
 * Commit in GitHub-Form — von GitHub *und* Gitea benutzt, Liste wie
 * Einzelabruf. `commit.author` ist bei GitHub ausdrücklich nullable (Commits
 * mit unparsbarem Autor), `author` (Host-User) ebenfalls.
 */
export interface GitHubStyleCommit {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: GitHubStyleGitUser | null;
    committer?: GitHubStyleGitUser | null;
  } | null;
  author?: { login?: string } | null;
  stats?: CommitStatsBlock | null;
  /** Nur am Einzel-Commit-Endpunkt; wir brauchen davon ausschließlich `length`. */
  files?: unknown[];
}

/** Release-Asset in GitHub-Form; das Format-Feld heißt bei beiden anders. */
export interface GitHubStyleReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

/**
 * Release in GitHub-Form — Gitea spiegelt sie feldgleich.
 * `name`/`body`/`published_at` sind bei GitHub nullable (Draft ohne Titel,
 * unveröffentlichter Release).
 */
export interface GitHubStyleRelease {
  id?: number | string;
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string;
  published_at?: string | null;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GitHubBranch extends BranchResponse {
  protected?: boolean;
}

export interface GitHubReleaseAsset extends GitHubStyleReleaseAsset {
  content_type?: string;
}

export interface GitHubRelease extends GitHubStyleRelease {
  assets?: GitHubReleaseAsset[];
}

// ---------------------------------------------------------------------------
// Gitea
// ---------------------------------------------------------------------------

/** Gitea hat am Listen-Commit zusätzlich `created` (Commit-Zeitpunkt). */
export interface GiteaCommit extends GitHubStyleCommit {
  created?: string;
}

export interface GiteaReleaseAsset extends GitHubStyleReleaseAsset {
  /** Erst ab neueren Gitea-Versionen ("attachment" | "external"). */
  type?: string;
}

export interface GiteaRelease extends GitHubStyleRelease {
  assets?: GiteaReleaseAsset[];
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

/** GitLab-Commit: flach, `id` statt `sha`, eigene Datumsfelder. */
export interface GitLabCommit {
  id?: string;
  message?: string;
  author_name?: string;
  author_email?: string;
  authored_date?: string;
  committed_date?: string;
  created_at?: string;
  web_url?: string;
  stats?: CommitStatsBlock | null;
}

export interface GitLabCommitDetail {
  stats?: CommitStatsBlock | null;
}

export interface GitLabBranch extends BranchResponse {
  default?: boolean;
}

/** Manuell angehängter Link. `direct_asset_url` fehlt ohne `direct_asset_path`. */
export interface GitLabReleaseAssetLink {
  name?: string;
  url?: string;
  direct_asset_url?: string;
  /** Erst ab GitLab 12.9 ("other" | "runbook" | "image" | "package"). */
  link_type?: string;
}

/** Automatisch erzeugtes Quellarchiv (zip, tar.gz, tar.bz2, tar). */
export interface GitLabReleaseSource {
  format?: string;
  url?: string;
}

export interface GitLabRelease {
  tag_name?: string;
  name?: string;
  description?: string;
  created_at?: string;
  released_at?: string;
  assets?: {
    links?: GitLabReleaseAssetLink[];
    sources?: GitLabReleaseSource[];
  } | null;
  _links?: { self?: string } | null;
}
