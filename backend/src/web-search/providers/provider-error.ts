import { isAxiosError } from 'axios';
import { errorMessage } from '../../common/narrow';

/**
 * Meldungstext für einen fehlgeschlagenen Provider-Aufruf — identisch für alle
 * vier Provider (Brave, SearXNG, SerpApi, Tavily), die vorher denselben Block
 * viermal hatten, jedes Mal eingeleitet mit `const ax = err as AxiosError`.
 *
 * Diese Behauptung war der Grund, warum der Nicht-Axios-Fall falsch aussah: ein
 * beliebiger geworfener Wert hat kein `message`, die Meldung lautete dann
 * wörtlich „Brave unreachable: undefined". `isAxiosError` prüft statt zu
 * behaupten, und für alles andere liefert `errorMessage` einen echten Text.
 */
export function providerErrorMessage(label: string, err: unknown): string {
  if (isAxiosError(err)) {
    if (err.response) return `${label} returned ${err.response.status}`;
    if (err.code === 'ECONNABORTED') return `${label} timeout`;
  }
  return `${label} unreachable: ${errorMessage(err)}`;
}
