import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowStatus,
} from '../schemas/workflow-definition.schema';
import { WorkflowsService } from '../workflows.service';
import { computeMissedSlots, computeNext } from './scheduler-helpers';
import { ScheduleTriggerConfig } from './types';
import { asNumber, errorMessage, isRecord, mongoErrorCode } from '../workflow-narrow';
import { asString } from '../../common/tool-args';

@Injectable()
export class WorkflowSchedulerService {
  private readonly logger = new Logger(WorkflowSchedulerService.name);
  private readonly definitionLocks = new Set<string>();

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly workflowsService: WorkflowsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (process.env.WORKFLOW_SCHEDULER_DISABLED === 'true') return;
    await this.processDueSchedules(new Date());
  }

  /** Exposed for tests / manual triggering. */
  async processDueSchedules(now: Date): Promise<void> {
    const due = await this.definitionModel
      .find({
        status: WorkflowStatus.ACTIVE,
        'trigger.type': 'schedule',
        $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: { $exists: false } }, { nextRunAt: null }],
      })
      .exec();

    for (const def of due) {
      const id = def._id.toString();
      if (this.definitionLocks.has(id)) continue;
      this.definitionLocks.add(id);
      try {
        await this.processDefinition(def, now);
      } catch (err: unknown) {
        this.logger.error(`Scheduler failed for ${def.name}: ${errorMessage(err)}`);
      } finally {
        this.definitionLocks.delete(id);
      }
    }
  }

  /**
   * `WorkflowDefinition.trigger` ist ein offenes `Record<string, unknown>` —
   * die Query filtert auf `trigger.type === 'schedule'`, über die Feldtypen
   * sagt das nichts. Sie werden hier geprüft statt behauptet; `asNumber`
   * übernimmt numerische Strings, damit ein `"intervalMinutes": "15"` aus dem
   * Editor weiterhin trägt (vorher durch JS-Coercion, nicht durch Absicht).
   */
  private readScheduleTrigger(trigger: unknown): ScheduleTriggerConfig {
    const raw = isRecord(trigger) ? trigger : {};
    return {
      type: 'schedule',
      cron: asString(raw.cron),
      intervalMinutes: asNumber(raw.intervalMinutes),
      timezone: asString(raw.timezone),
      maxCatchUp: asNumber(raw.maxCatchUp),
    };
  }

  private async processDefinition(def: WorkflowDefinitionDocument, now: Date): Promise<void> {
    const trigger = this.readScheduleTrigger(def.trigger);
    let slots: Date[];
    try {
      slots = computeMissedSlots(def.lastRunAt, now, trigger);
    } catch (err: unknown) {
      this.logger.warn(`Invalid schedule trigger on "${def.name}": ${errorMessage(err)}`);
      return;
    }

    for (const slot of slots) {
      try {
        await this.workflowsService.startRun({
          definitionId: def._id.toString(),
          triggeredBy: { type: 'schedule', scheduleSlotAt: slot.toISOString() },
        });
      } catch (err: unknown) {
        if (mongoErrorCode(err) !== 11000) throw err;
        this.logger.debug(`Skipped duplicate slot ${slot.toISOString()} for ${def.name}`);
      }
    }

    try {
      def.nextRunAt = computeNext(trigger, now);
    } catch {
      def.nextRunAt = undefined;
    }
    def.lastRunAt = now;
    await def.save();
  }
}
