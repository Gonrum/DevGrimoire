import { ResearchFrequency } from './schemas/research-topic.schema';

/** Minimal schedule shape `computeNextRun` needs — a subset of `ResearchSchedule`. */
export interface ResearchScheduleInput {
  frequency: ResearchFrequency | string;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
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
 */
export function computeNextRun(from: Date, s: ResearchScheduleInput): Date {
  const { frequency, hour, dayOfWeek, dayOfMonth, month } = s;
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(hour);

  switch (frequency) {
    case ResearchFrequency.DAILY:
      // Next day at the specified hour.
      next.setUTCDate(next.getUTCDate() + 1);
      break;

    case ResearchFrequency.WEEKLY: {
      const targetDay = dayOfWeek ?? 1; // default Monday
      next.setUTCDate(next.getUTCDate() + 1); // at least tomorrow
      while (next.getUTCDay() !== targetDay) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      break;
    }

    case ResearchFrequency.BIWEEKLY: {
      const targetDay2 = dayOfWeek ?? 1;
      next.setUTCDate(next.getUTCDate() + 1);
      while (next.getUTCDay() !== targetDay2) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      // Skip one more week.
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    }

    case ResearchFrequency.MONTHLY: {
      const targetDom = dayOfMonth ?? 1;
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(
        Math.min(targetDom, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()),
      );
      break;
    }

    case ResearchFrequency.QUARTERLY: {
      const targetDomQ = dayOfMonth ?? 1;
      next.setUTCMonth(next.getUTCMonth() + 3);
      next.setUTCDate(
        Math.min(targetDomQ, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()),
      );
      break;
    }

    case ResearchFrequency.YEARLY: {
      const targetMonth = (month ?? 1) - 1; // month is 1-indexed
      const targetDomY = dayOfMonth ?? 1;
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      next.setUTCMonth(targetMonth);
      next.setUTCDate(
        Math.min(targetDomY, new Date(Date.UTC(next.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate()),
      );
      break;
    }
  }

  // If the computed instant is still not strictly in the future, add one more cycle.
  if (next <= from) {
    return computeNextRun(next, s);
  }

  return next;
}
