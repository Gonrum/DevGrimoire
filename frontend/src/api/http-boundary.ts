/**
 * Die HTTP-Grenze des Frontends (M-52 / T-455, T-458).
 *
 * Hier — und nur hier — wird aus einer ungeprüften JSON-Antwort ein getypter
 * Wert. Genau diese Rolle rechtfertigt die Behauptung, und genau deshalb steht
 * sie in dieser winzigen Datei statt in `client.ts`: dort hängen 3.833 Zeilen
 * API-Oberfläche dran, die keine Ausnahme brauchen sollen.
 *
 * `no-unsafe-type-assertion` ist für diese Datei in `eslint.config.mjs` per
 * Override abgeschaltet, mit Begründung dort. Wer die Ausnahme schliessen will,
 * braucht einen Schema-Validator an der Grenze (zod o.ä.) — nicht mehr Casts.
 */

/**
 * JSON-Body einer Antwort als `T`.
 *
 * `res.json()` liefert `Promise<any>`; ohne diese Stelle floss dieses `any` in
 * jede einzelne API-Funktion und von dort in die Komponenten.
 */
export async function parseJsonResponse<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Fehlermeldung aus einem Error-Body, ohne auf dessen Form zu vertrauen. */
export async function readErrorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (body !== null && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return res.statusText;
}

/**
 * Führt `HeadersInit` in ein Plain Object zusammen.
 *
 * Vorher stand hier `options?.headers as Record<string, string>`. Das war eine
 * Lüge: `HeadersInit` ist `string[][] | Record<string, string> | Headers`, und
 * eine `Headers`-Instanz lässt sich nicht in ein Objekt spreaden — ihre Einträge
 * wären **still verschwunden**. Aktuell übergibt kein Aufrufer diese Formen, der
 * Fehler war also latent; hier ist er zu.
 */
export function mergeHeaders(
  base: Record<string, string>,
  extra: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  if (!extra) return out;
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(extra)) {
    for (const pair of extra) {
      const [key, value] = pair;
      if (typeof key === 'string' && typeof value === 'string') out[key] = value;
    }
    return out;
  }
  return { ...out, ...extra };
}

/**
 * Antwort ohne Body (HTTP 204). Aufrufer deklarieren dort typischerweise `void`
 * oder einen optionalen Typ; die Behauptung gehört an die Grenze, nicht in jede
 * der ~200 API-Funktionen.
 */
export function parseEmptyResponse<T>(): T {
  return undefined as T;
}

/**
 * JSON-Text als `T` — für Stellen, die keinen `Response` haben: SSE-Frames,
 * WebSocket-Nachrichten, `xhr.responseText`.
 *
 * Wirft bei ungültigem JSON weiter (wie `JSON.parse`), damit der Aufrufer
 * entscheidet: ein SSE-Frame darf verworfen werden, eine Upload-Antwort nicht.
 */
export function parseJsonText<T>(text: string): T {
  return JSON.parse(text) as T;
}

/**
 * Fehlermeldung aus einem JSON-Text, ohne auf dessen Form zu vertrauen.
 * Ungültiges JSON ergibt `undefined`, damit der Aufrufer seinen Fallback nutzt.
 */
export function readErrorMessageFromText(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (body !== null && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}
