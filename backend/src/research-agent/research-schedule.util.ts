import { ResearchFrequency } from './schemas/research-topic.schema';

/** Minimal schedule shape `computeNextRun` needs — a subset of `ResearchSchedule`. */
export interface ResearchScheduleInput {
  /**
   * Als `string` deklariert, nicht als `ResearchFrequency`: der Wert kommt aus
   * einem Mongoose-Dokument (`@Prop({type: Object})`, also ohne Enum-Validierung
   * durch das Schema) und aus den `.cjs`-Checks. Geprüft wird er zur Laufzeit in
   * `computeNextRun` — vor dem `switch`, siehe dort.
   */
  frequency: string;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
}

// Als `readonly string[]` deklariert (Zuweisung verbreitert, keine Assertion),
// damit unten String gegen String verglichen wird. Ein `enumWert === fremderString`
// wäre genau der Vergleich, den `no-unsafe-enum-comparison` verhindert — und die
// Regel hat recht: an so einer Stelle ist die Behauptung „das ist ein Enum-Wert"
// unbelegt, solange sie nicht geprüft wurde.
const FREQUENCY_VALUES: readonly string[] = Object.values(ResearchFrequency);

function isResearchFrequency(value: string): value is ResearchFrequency {
  return FREQUENCY_VALUES.includes(value);
}

/** Letzter Tag des Monats, in dem `date` liegt (UTC). */
function lastDayOfMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Verschiebt `date` um `months` Monate und setzt den Tag auf
 * `min(dayOfMonth, letzter Tag des Zielmonats)`.
 *
 * Der Tag wird **vor** der Monatsverschiebung auf 1 gesetzt. Ohne das rutscht
 * ein 31. beim Sprung in einen kürzeren Monat weiter: `setUTCMonth(+1)` am
 * 31. Januar ergibt den 31. Februar → 3. März, und die anschließende
 * Klammerung rechnete dann mit der Länge des *März*. Aus „nächster Lauf am
 * 15. Februar" wurde so der 15. März — ein stillschweigend übersprungener
 * Monat, jedes Mal wenn ein Lauf auf den 29.–31. fiel.
 */
function shiftMonths(date: Date, months: number, dayOfMonth: number): void {
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  date.setUTCDate(Math.min(dayOfMonth, lastDayOfMonth(date)));
}

/**
 * Optionales Zeitplan-Feld: fehlt es, gilt `fallback`; ist es gesetzt, muss es
 * eine ganze Zahl im erlaubten Bereich sein.
 *
 * Der Bereich wird geprüft, weil ein Wert daneben nicht „ungefähr richtig"
 * rechnet, sondern kaputt: `dayOfWeek: 7` lässt `while (next.getUTCDay() !==
 * 7)` **nie** enden — `getUTCDay()` liefert nur 0–6. Das ist keine falsche
 * Uhrzeit, das ist ein hängender Cron-Tick, der den Prozess mitnimmt. Die
 * DTO-Validierung deckt nur den API-Weg ab; hier kommen auch Dokumente an, die
 * Replikation, ein Skript oder eine ältere Programmversion geschrieben hat.
 */
function scheduleInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`Invalid research schedule ${field}: ${String(value)}`);
  }
  return resolved;
}

/**
 * Pure schedule-math function: given a base instant `from` and a schedule
 * spec, returns the next UTC instant the schedule should fire.
 *
 * Ported/duplicated from
 * `recurring-tasks.service.ts#computeNextRunFromDate` (~line 383) as a
 * deliberate, pre-confirmed decoupling of the research-agent module from
 * recurring-tasks (NOT a DRY defect — see Task 8 brief). Unlike the
 * recurring-tasks original, this operates entirely in UTC (`getUTC*`/
 * `setUTC*`) so behavior is independent of the host machine's timezone, and
 * takes `from` as an explicit argument — no `this`, no argument-less
 * `new Date()`.
 *
 * Alle Eingaben werden **vor** der Rechnung geprüft und ein Fehler wird
 * geworfen. Der Grund ist die Rechenart selbst: aus einem ungültigen Feld
 * entsteht hier kein falsches Datum, sondern ein `Invalid Date`, und das ist in
 * jedem Vergleich `false` — `next <= from` wäre nicht erfüllt, das kaputte
 * Datum würde als `schedule.nextRun` gespeichert, und der Filter in `findDue`
 * (`$lte: now`) fände das Thema nie wieder. Ein Thema, das lautlos nie mehr
 * läuft, ist der schlechtere Ausgang gegenüber einem Fehler im Log.
 */
export function computeNextRun(from: Date, s: ResearchScheduleInput): Date {
  const { frequency, hour, dayOfWeek, dayOfMonth, month } = s;

  if (Number.isNaN(from.getTime())) {
    throw new Error('computeNextRun: "from" is an Invalid Date');
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid research schedule hour: ${String(hour)}`);
  }
  // Die Prüfung der Frequenz gehört vor den `switch`, nicht als `default:`
  // hinein: deckt der `switch` alle Enum-Werte ab, ist der Wert im `default:`
  // für TS `never` — der Zweig kann den unerwarteten Wert dann nicht einmal
  // mehr in die Fehlermeldung schreiben.
  if (!isResearchFrequency(frequency)) {
    throw new Error('Unknown research frequency: ' + frequency);
  }

  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(hour);

  switch (frequency) {
    case ResearchFrequency.DAILY:
      // Next day at the specified hour.
      next.setUTCDate(next.getUTCDate() + 1);
      break;

    case ResearchFrequency.WEEKLY: {
      const targetDay = scheduleInt(dayOfWeek, 1, 0, 6, 'dayOfWeek'); // default Monday
      next.setUTCDate(next.getUTCDate() + 1); // at least tomorrow
      while (next.getUTCDay() !== targetDay) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      break;
    }

    case ResearchFrequency.BIWEEKLY: {
      const targetDay2 = scheduleInt(dayOfWeek, 1, 0, 6, 'dayOfWeek');
      next.setUTCDate(next.getUTCDate() + 1);
      while (next.getUTCDay() !== targetDay2) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      // Skip one more week.
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    }

    case ResearchFrequency.MONTHLY:
      shiftMonths(next, 1, scheduleInt(dayOfMonth, 1, 1, 31, 'dayOfMonth'));
      break;

    case ResearchFrequency.QUARTERLY:
      shiftMonths(next, 3, scheduleInt(dayOfMonth, 1, 1, 31, 'dayOfMonth'));
      break;

    case ResearchFrequency.YEARLY: {
      const targetMonth = scheduleInt(month, 1, 1, 12, 'month') - 1; // month is 1-indexed
      const targetDomY = scheduleInt(dayOfMonth, 1, 1, 31, 'dayOfMonth');
      // Tag zuerst auf 1: sonst rutscht ein 29.–31. beim Jahres-/Monatswechsel
      // in den Folgemonat (29. Februar + 1 Jahr = 1. März).
      next.setUTCDate(1);
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      next.setUTCMonth(targetMonth);
      next.setUTCDate(Math.min(targetDomY, lastDayOfMonth(next)));
      break;
    }
  }

  // If the computed instant is still not strictly in the future, add one more cycle.
  if (next <= from) {
    return computeNextRun(next, s);
  }

  return next;
}

/** Result shape of `nextStatusUpdate` — the exact fields `ResearchSchedule`
 * tracks about its last/next firing. */
export interface ScheduleStatusUpdate {
  lastRun: Date;
  nextRun: Date;
  lastRunStatus: string;
}

/**
 * Pure schedule-status-patch computation, extracted out of
 * `ResearchTopicService.markRun` so it is unit-testable without a Mongoose
 * model (see `scripts/research-due-check.cjs`).
 *
 * `ranAt` MUST be the instant `ResearchScheduler.handleCron` decided to fire
 * the topic (i.e. the cron tick's own `now`), NOT a timestamp taken after the
 * research run has executed. Computing `nextRun` from `ranAt` up front — and
 * persisting it via `markRun` BEFORE `ResearchAgentService.run` is even
 * called — is what keeps a slow or crashing run from being re-fired on the
 * very next tick: whether the run ends up `done`, `error`, or is skipped
 * entirely (topic already has an active run), `nextRun` has already moved on
 * by the time anything else happens.
 */
export function nextStatusUpdate(
  topic: { schedule: ResearchScheduleInput },
  ranAt: Date,
  status: string,
): ScheduleStatusUpdate {
  return {
    lastRun: ranAt,
    nextRun: computeNextRun(ranAt, topic.schedule),
    lastRunStatus: status,
  };
}
