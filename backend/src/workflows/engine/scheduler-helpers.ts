import { parseExpression } from 'cron-parser';
import { ScheduleTriggerConfig } from './types';

const DEFAULT_MAX_CATCHUP = 1;

/** Next nominal slot strictly after `after`. Throws on invalid trigger. */
export function computeNext(trigger: ScheduleTriggerConfig, after: Date): Date {
  if (trigger.cron) {
    const it = parseExpression(trigger.cron, {
      currentDate: after,
      tz: trigger.timezone,
    });
    return it.next().toDate();
  }
  if (trigger.intervalMinutes && trigger.intervalMinutes > 0) {
    return new Date(after.getTime() + trigger.intervalMinutes * 60_000);
  }
  throw new Error('schedule trigger requires cron or intervalMinutes');
}

/**
 * Returns up to `maxCatchUp` nominal slot times that have already elapsed
 * between `lastRunAt` (exclusive) and `now` (inclusive). When the workflow
 * has never run (`lastRunAt` undefined), returns just the most recent slot
 * up to `now` so the first cron tick fires once and not from the dawn of time.
 */
export function computeMissedSlots(
  lastRunAt: Date | undefined,
  now: Date,
  trigger: ScheduleTriggerConfig,
  maxCatchUp = trigger.maxCatchUp ?? DEFAULT_MAX_CATCHUP,
): Date[] {
  if (maxCatchUp <= 0) return [];

  if (!lastRunAt) {
    // First-ever schedule check: don't backfill, just queue current slot if due.
    const next = computeNext(trigger, new Date(now.getTime() - 1));
    return next <= now ? [next] : [];
  }

  const slots: Date[] = [];
  let cursor = new Date(lastRunAt.getTime());
  while (slots.length < maxCatchUp) {
    const next = computeNext(trigger, cursor);
    if (next > now) break;
    slots.push(next);
    cursor = next;
  }
  // If we hit the cap but more slots remain, the *latest* slots are most useful
  // — but our walker already yielded the earliest ones. n8n-style catch-up is
  // earliest-first, which is what we want for ordering preservation.
  return slots;
}
