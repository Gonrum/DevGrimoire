import { isRecord } from '../common/narrow';

/**
 * Persönliche Benachrichtigungs-Einstellungen (Push-Kategorien, Ruhezeiten).
 *
 * Vorher lagen sie nur instanzweit in den Settings und waren nur für Admins
 * schreibbar — die Einstellungsseite für Nicht-Admins verschluckte den 403, der
 * Schalter sprang um, gespeichert wurde nichts. Ein Freigeben der globalen Keys
 * hätte jedem Nutzer erlaubt, die Pushes aller anderen stummzuschalten.
 *
 * Jetzt am Nutzer. Die instanzweiten Keys bleiben der Default für Nutzer ohne
 * eigene Einstellung und für besitzerlose Abos.
 */
export interface QuietHours {
  enabled: boolean;
  from: string;
  to: string;
  overrides: string[];
}

export interface NotificationPrefs {
  pushCategories: string[];
  quietHours: QuietHours;
}

/** Gespeicherte Form am Nutzer — einzelne Teile dürfen fehlen. */
export interface StoredNotificationPrefs {
  pushCategories?: string[];
  quietHours?: QuietHours;
}

export const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const HHMM_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;
export const MAX_CATEGORIES = 100;

export function parseHHMM(value: string): number | null {
  const m = HHMM_PATTERN.exec(value.trim());
  if (!m) return null;
  const [h, mm] = value.trim().split(':').map(Number);
  return h * 60 + mm;
}

export function splitCsv(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map((c) => c.trim()).filter(Boolean);
}

/** Eigene Einstellung des Nutzers vor dem Instanz-Default, teilweise je Abschnitt. */
export function effectivePrefs(stored: unknown, defaults: NotificationPrefs): NotificationPrefs {
  if (!isRecord(stored)) return defaults;
  const cats = Array.isArray(stored.pushCategories)
    ? stored.pushCategories.filter((c): c is string => typeof c === 'string')
    : null;
  const q = stored.quietHours;
  const quiet: QuietHours | null =
    isRecord(q) && typeof q.enabled === 'boolean' && typeof q.from === 'string' && typeof q.to === 'string'
      ? {
          enabled: q.enabled,
          from: q.from,
          to: q.to,
          overrides: Array.isArray(q.overrides) ? q.overrides.filter((c): c is string => typeof c === 'string') : [],
        }
      : null;
  return {
    pushCategories: cats ?? defaults.pushCategories,
    quietHours: quiet ?? defaults.quietHours,
  };
}

/**
 * Liegt `now` im Ruhefenster und ist die Kategorie keine Ausnahme? Fail-open:
 * eine unlesbare Zeit unterdrückt nichts — ein verschluckter Push ist
 * schlimmer als einer zu viel.
 */
export function isQuiet(quiet: QuietHours, category: string | undefined, now: Date): boolean {
  if (!quiet.enabled) return false;
  if (category && quiet.overrides.includes(category)) return false;
  const fromMin = parseHHMM(quiet.from);
  const toMin = parseHHMM(quiet.to);
  if (fromMin === null || toMin === null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Fenster über Mitternacht, wenn from > to (z.B. 22:00 → 07:00).
  return fromMin <= toMin
    ? nowMin >= fromMin && nowMin < toMin
    : nowMin >= fromMin || nowMin < toMin;
}

/**
 * Darf ein Push dieser Kategorie raus? Ohne Kategorie gibt es keinen
 * Kategorie-Filter, nur die Ruhezeit (wie bisher).
 */
export function allowsPush(prefs: NotificationPrefs, category: string | undefined, now: Date): boolean {
  if (category && !prefs.pushCategories.includes(category)) return false;
  return !isQuiet(prefs.quietHours, category, now);
}
