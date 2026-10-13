import { errorMessageWithCause, isRecord } from '../common/narrow';

/** Obergrenze für jede Kube-Fehlermeldung, die einen Aufrufer erreicht. */
export const KUBE_ERROR_MAX_CHARS = 500;

/**
 * Lesbare, gekappte Meldung aus einem Kube-Fehler — für REST UND MCP (M-19).
 *
 * `ApiException.message` ist der Debug-String aus ihrem Konstruktor
 * ("HTTP-Code: 404\nMessage: …\nBody: {…}\nHeaders: {…}"). Body und Header
 * tragen keine Credentials, aber Audit-Ids, Proxy-Banner und interne
 * Hostnamen — und waren im 4xx-Zweig des Controllers und im MCP-Fehlerpfad
 * ungekürzt beim Aufrufer. Bevorzugt wird die Kubernetes-`Status.message`
 * aus `.body` ("pods \"foo\" not found"); sonst der Debug-String bis vor
 * `Body:`, und alles auf KUBE_ERROR_MAX_CHARS.
 */
export function kubeApiExceptionMessage(err: unknown): string {
  if (isRecord(err) && isRecord(err.body) && typeof err.body.message === 'string') {
    return err.body.message.slice(0, KUBE_ERROR_MAX_CHARS);
  }
  const raw = errorMessageWithCause(err);
  const cut = raw.search(/\n(Body|Headers):/);
  return (cut >= 0 ? raw.slice(0, cut) : raw).slice(0, KUBE_ERROR_MAX_CHARS);
}

/**
 * `@kubernetes/client-node`s `ApiException` (gen/apis/exception.js) trägt den
 * echten HTTP-Status der Cluster-API in `.code` — kein Nest-`HttpException`,
 * also unsichtbar für `err instanceof HttpException`. Ohne diese Erkennung
 * landete jedes Cluster-4xx (Pod nicht gefunden, RBAC verweigert, Token
 * abgelaufen) hinter einem 503 "cluster unavailable" — genau während des
 * Incidents, in dem diese Unterscheidung zählt.
 */
export function kubeApiExceptionCode(err: unknown): number | undefined {
  return isRecord(err) && typeof err.code === 'number' ? err.code : undefined;
}
