import { isRecord, isUnknownArray } from './narrow';

/**
 * Leser für die Vorschau eines Tool-Aufrufs (T-415).
 *
 * Bewusst hier statt in der Komponente: **alles hier verarbeitet ungeprüfte
 * Modell-Ausgabe.** Die Argumente stammen aus einem `JSON.parse` über einen vom
 * LLM erzeugten String — jedes Feld kann fehlen, leer oder vom falschen Typ
 * sein, Listen können Skalare enthalten. Keine dieser Funktionen darf werfen:
 * ein kaputter Vorschlag soll ablehnbar sein, nicht den ganzen Chat blockieren.
 *
 * Als eigene Datei sind sie ausserdem ohne React prüfbar.
 */

export interface PreviewTodo {
  title: string;
  priority?: string;
  tags: string[];
  description?: string;
  userStories?: string;
  acceptanceCriteria: string[];
  outOfScope?: string;
  edgeCases?: string;
}

/** Nicht-leerer String oder `undefined` — leere Felder sollen nichts anzeigen. */
export function previewText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Nur echte Strings; ein Zahlen- oder Objekt-Eintrag in `tags` fällt raus. */
export function previewStringList(value: unknown): string[] {
  if (!isUnknownArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && !!v.trim());
}

/**
 * Akzeptanzkriterien: das Schema sagt `[{text, done?}]`, Modelle liefern aber
 * regelmässig eine reine Stringliste. Beide Formen werden gelesen — die
 * Vorschau soll zeigen, was gemeint ist, nicht auf der Form bestehen.
 */
export function previewCriteria(value: unknown): string[] {
  if (!isUnknownArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry);
    else if (isRecord(entry)) {
      const t = previewText(entry.text);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Die Todo-Liste eines `milestone_create_with_todos`-Aufrufs.
 *
 * Ein Eintrag ohne lesbaren Titel wird mit leerem Titel übernommen, nicht
 * verworfen: der Nutzer soll sehen, dass der Vorschlag Lücken hat, statt
 * stillschweigend weniger Todos angezeigt zu bekommen, als angelegt würden.
 */
export function previewTodos(value: unknown): PreviewTodo[] {
  if (!isUnknownArray(value)) return [];
  return value.filter(isRecord).map((raw) => ({
    title: previewText(raw.title) ?? '',
    priority: previewText(raw.priority),
    tags: previewStringList(raw.tags),
    description: previewText(raw.description),
    userStories: previewText(raw.userStories),
    acceptanceCriteria: previewCriteria(raw.acceptanceCriteria),
    outOfScope: previewText(raw.outOfScope),
    edgeCases: previewText(raw.edgeCases),
  }));
}
