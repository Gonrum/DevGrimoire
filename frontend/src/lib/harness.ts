import { isRecord, isUnknownArray } from './narrow';

/**
 * Anzahl der Abschnitte einer Harness-Ebene (M-51/H1).
 *
 * Nimmt `unknown` statt `Harness | Record<string, never>`: bei der Union macht
 * die Index-Signatur des leeren Zweigs aus `value.sections` ein `never`, und
 * die Prüfung liesse sich nur noch per Behauptung umgehen. Mit `unknown` prüfen
 * die beiden Prädikate ehrlich durch.
 *
 * Gezählt wird die EIGENE Ebene, nicht das Geerbte — sonst zeigte jedes Projekt
 * dieselbe Zahl, nämlich die der globalen Abschnitte.
 */
export function harnessSectionCount(value: unknown): number {
  return isRecord(value) && isUnknownArray(value.sections) ? value.sections.length : 0;
}
