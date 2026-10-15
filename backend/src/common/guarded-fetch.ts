import { outboundGuard } from './outbound-guard';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Wie die Fetch-Spezifikation. */
const MAX_REDIRECTS = 20;
/** Fallen bei einem Origin-Wechsel weg — wie in der Fetch-Spezifikation bzw. undici. */
const CROSS_ORIGIN_DROPPED = ['authorization', 'cookie', 'proxy-authorization'];
/** Fallen weg, wenn ein Redirect aus dem Request ein bodyloses GET macht. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

export interface GuardedFetchOptions {
  /** Redirects folgen — jeder Sprung wird erneut geprüft. */
  followRedirects: boolean;
  guard?: Pick<typeof outboundGuard, 'assertUrl'>;
  fetchImpl?: typeof fetch;
}

/**
 * `fetch` gegen ein nutzerkonfiguriertes Ziel (M-4).
 *
 * Prüft das Ziel mit dem Outbound-Guard, bevor verbunden wird. Redirects folgt
 * die Funktion selbst statt `redirect: 'follow'`: sonst ginge ein
 * `302 Location: http://169.254.169.254/` am Guard vorbei. Die Semantik
 * entspricht dem, was `fetch` beim Folgen tut — 303 (und 301/302 nach POST)
 * werden zum GET ohne Body, ein Origin-Wechsel lässt Credential-Header fallen.
 *
 * Restrisiko DNS-Rebinding: geprüft wird die Auflösung des Guards, verbunden
 * wird über die von `fetch`. Für HTTPS lässt sich die Adresse ohne eigenen
 * Dispatcher nicht festnageln, ohne SNI und Zertifikatsprüfung zu verlieren.
 */
export async function guardedFetch(url: string | URL, init: RequestInit, opts: GuardedFetchOptions): Promise<Response> {
  const guard = opts.guard ?? outboundGuard;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = new URL(url);
  let reqInit: RequestInit = { ...init, redirect: 'manual' };

  for (let hop = 0; ; hop++) {
    await guard.assertUrl(current);
    const res = await doFetch(current.toString(), reqInit);
    if (!opts.followRedirects || !REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      await res.body?.cancel().catch(() => {});
      throw new TypeError(`redirect count exceeded (${MAX_REDIRECTS})`);
    }
    await res.body?.cancel().catch(() => {});

    const next = new URL(location, current);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new TypeError(`redirect to unsupported protocol ${next.protocol}`);
    }
    const headers = new Headers(reqInit.headers);
    const method = (reqInit.method ?? 'GET').toUpperCase();
    if (res.status === 303 ? method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST') {
      for (const h of BODY_HEADERS) headers.delete(h);
      reqInit = { ...reqInit, method: 'GET', body: undefined };
    }
    if (next.origin !== current.origin) {
      for (const h of CROSS_ORIGIN_DROPPED) headers.delete(h);
    }
    reqInit = { ...reqInit, headers };
    current = next;
  }
}
