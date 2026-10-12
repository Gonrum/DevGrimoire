/**
 * Übersetzt den `TRUST_PROXY`-Env-Wert in das, was Express erwartet.
 *
 * Express' `trust proxy` akzeptiert `boolean`, eine Anzahl Hops (`number`),
 * ein Subnetz (`string`), oder eine Liste davon (`Array`). Aus der Env kommt
 * immer ein String, also muss die Übersetzung explizit sein — ein
 * `app.set('trust proxy', process.env.TRUST_PROXY)` würde den String `'1'`
 * als SUBNETZ-Angabe übergeben, nicht als Hop-Anzahl, und `'false'` wäre
 * truthy.
 *
 * Warum das überhaupt nötig ist: ohne `trust proxy` wertet Express die
 * `X-Forwarded-For`-/`X-Real-IP`-Header nicht aus, die der vorgeschaltete
 * nginx korrekt setzt (`frontend/nginx.conf`, alle Locations). `req.ip` ist
 * dann für JEDEN Request die Adresse des nginx-Containers. Davon hängen drei
 * Dinge ab, die alle still kaputt waren:
 *
 * 1. `ThrottlerGuard.getTracker()` liefert `req.ip` (@nestjs/throttler 6.5.0,
 *    `throttler.guard.js:141-143`). `@Throttle({ limit: 5, ttl: 60000 })` auf
 *    `/api/auth/login` war damit ein GLOBALER Eimer: fünf Fehlversuche
 *    irgendeines Clients sperrten das Login für die ganze Instanz — ein
 *    Login-DoS für alle, und pro Angreifer faktisch keine Bremse.
 * 2. Die Refresh-Token-IP-Bindung (`auth.service.ts`) war toter Code:
 *    `stored.ip` und `clientInfo.ip` waren immer dieselbe nginx-Adresse, die
 *    Warnung bei IP-Wechsel konnte nie auslösen.
 * 3. Jedes `ipAddress` im Audit-Log (`audit-log.schema.ts`) war die
 *    nginx-Adresse — Forensik unmöglich, obwohl `docs/security.md` und die
 *    Kube-Pläne ausnahmslose Nachvollziehbarkeit zusagen.
 *
 * Default `1` (als Zahl, siehe unten): im dokumentierten Deployment
 * (docker-compose) hängt genau EIN Reverse Proxy davor. `1` bedeutet, dass
 * Express die `X-Forwarded-For`-Liste von rechts nach links um einen Hop
 * entrollt und die letzte nicht vertraute Adresse als Client nimmt. Spoofing
 * funktioniert damit nicht: schickt ein Client `X-Forwarded-For: gefälscht`
 * direkt an nginx, HÄNGT nginx die echte Client-Adresse an
 * (`gefälscht, echt`), und `1` liefert `echt`.
 *
 * Läuft das Backend dagegen OHNE vorgelagerten Proxy (Entwicklung, oder die
 * direkte Port-Bindung `3200:3000` aus docker-compose.yml), muss
 * `TRUST_PROXY=false` gesetzt werden — sonst vertraut Express dem Header des
 * Clients selbst und das Throttling ist per Header umgehbar.
 */
export function resolveTrustProxy(
  raw: string | undefined,
): boolean | number | string | Array<string | number> {
  const value = raw?.trim();
  // Kein Wert: der Compose-Default mit genau einem Reverse Proxy.
  //
  // Bewusst die ZAHL 1, nicht der String '1': Express reicht den Wert an
  // `proxy-addr` weiter, und das unterscheidet die Typen — eine `number` wird
  // zur Hop-Anzahl, ein `string` wird als IP-Adresse bzw. Subnetz geparst.
  // `'1'` wäre also keine gültige Hop-Angabe, sondern ein Parse-Versuch einer
  // IP. Dieselbe Falle behandelt resolveSingle() für explizit gesetzte Werte.
  if (value === undefined || value === '') return 1;

  const lower = value.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === 'no') return false;
  if (lower === 'true' || lower === 'on' || lower === 'yes') return true;

  // Liste (`'loopback, 10.0.0.0/8'`) — Express akzeptiert Arrays.
  if (value.includes(',')) {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.map((part) => resolveSingle(part));
  }
  return resolveSingle(value);
}

/**
 * Ein einzelner Wert. Nur eine reine Ganzzahl wird zur `number` — alles andere
 * bleibt String, damit Express selbst über Subnetze und die benannten Bereiche
 * (`loopback`, `uniquelocal`, `linklocal`, `loopback, uniquelocal`) entscheidet.
 */
function resolveSingle(value: string): number | string {
  const lower = value.toLowerCase();
  if (lower === 'false') return 0;
  if (!/^\d+$/.test(lower)) return value;
  const parsed = Number.parseInt(lower, 10);
  // `0` Hops ist sinnlos (Express behandelt es wie `false`); negativ gibt es
  // nicht, weil das Regexp nur Ziffern zulässt.
  return Number.isFinite(parsed) ? parsed : value;
}
