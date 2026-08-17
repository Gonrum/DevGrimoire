import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { errorMessage, isDuplicateKeyError } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { Todo, TodoDocument, TodoStatus } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneDocument, MilestoneStatus } from '../milestones/schemas/milestone.schema';
import {
  ValidationReport,
  ValidationReportDocument,
  ValidationReportStatus,
} from '../validation-reports/schemas/validation-report.schema';
import { TodosService } from '../todos/todos.service';
import { TodoPriority, TodoDocument as TodoDoc } from '../todos/schemas/todo.schema';
import { CommentOracleOnTodoDto, ConvertOracleToTodoDto, ListOracleSuggestionsDto } from './dto/oracle.dto';
import {
  OracleRiskType,
  OracleSeverity,
  OracleSuggestion,
  OracleSuggestionDocument,
  OracleSuggestionStatus,
} from './schemas/oracle-suggestion.schema';
import { KgEntityType } from '../knowledge-graph/schemas/knowledge-graph-edge.schema';

const STAGNATION_DAYS = 14;
const STAGNATION_CRITICAL_DAYS = 30;
const DEADLINE_WARN_DAYS = 14;
const DEADLINE_CRITICAL_DAYS = 7;
const DEADLINE_MIN_OPEN_RATIO = 0.4;
const HOTSPOT_WINDOW_DAYS = 7;
const HOTSPOT_MIN_FAILURES = 3;
const BLOCKER_CHAIN_WARN = 3;

interface DetectorContext {
  projectId: string;
  todos: TodoDocument[];
  milestones: MilestoneDocument[];
  validationReports: ValidationReportDocument[];
  todoById: Map<string, TodoDocument>;
}

interface DetectedSuggestion {
  type: OracleRiskType;
  severity: OracleSeverity;
  title: string;
  reason: string;
  recommendedAction: string;
  affectedEntities: Array<{ entityType: KgEntityType; entityId: string; label?: string }>;
  fingerprintExtra: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);

  constructor(
    @InjectModel(OracleSuggestion.name)
    private readonly suggestionModel: Model<OracleSuggestionDocument>,
    @InjectModel(Todo.name) private readonly todoModel: Model<TodoDocument>,
    @InjectModel(Milestone.name) private readonly milestoneModel: Model<MilestoneDocument>,
    @InjectModel(ValidationReport.name)
    private readonly validationReportModel: Model<ValidationReportDocument>,
    private readonly todosService: TodosService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---- Detectors ----------------------------------------------------------

  private detectStagnation(ctx: DetectorContext): DetectedSuggestion[] {
    const out: DetectedSuggestion[] = [];
    const now = Date.now();
    for (const t of ctx.todos) {
      if (t.status !== TodoStatus.IN_PROGRESS && t.status !== TodoStatus.REVIEW) continue;
      const updatedRaw = t.updatedAt;
      const updated = updatedRaw ? new Date(updatedRaw).getTime() : now;
      const days = Math.floor((now - updated) / (1000 * 60 * 60 * 24));
      if (days < STAGNATION_DAYS) continue;
      const severity = days >= STAGNATION_CRITICAL_DAYS ? OracleSeverity.CRITICAL : OracleSeverity.WARN;
      const label = t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title;
      out.push({
        type: OracleRiskType.STAGNATION,
        severity,
        title: `Quest steckt seit ${days} Tagen in "${t.status}": ${label}`,
        reason:
          `Der Todo befindet sich seit ${days} Tagen ohne Update im Status "${t.status}". ` +
          `Üblicherweise sollte ein Todo in dieser Phase aktiv bewegt werden, sonst droht Wissensverlust.`,
        recommendedAction:
          'Status prüfen: Ist die Quest noch relevant? Gibt es einen Blocker? Ggf. einen Blocker-Todo anlegen, ' +
          'kommentieren oder zurück auf "open" / weiter auf "done" / "review" schieben.',
        affectedEntities: [{ entityType: 'todo', entityId: t._id.toString(), label }],
        fingerprintExtra: `stagnation|todo:${t._id.toString()}`,
        metadata: { daysIdle: days, status: t.status },
      });
    }
    return out;
  }

  private detectDeadlinePressure(ctx: DetectorContext): DetectedSuggestion[] {
    const out: DetectedSuggestion[] = [];
    const todosByMilestone = new Map<string, TodoDocument[]>();
    for (const t of ctx.todos) {
      if (!t.milestoneId) continue;
      const mid = t.milestoneId.toString();
      if (!todosByMilestone.has(mid)) todosByMilestone.set(mid, []);
      todosByMilestone.get(mid)!.push(t);
    }
    const now = Date.now();
    for (const m of ctx.milestones) {
      if (m.status === MilestoneStatus.DONE || m.archived) continue;
      if (!m.dueDate) continue;
      const due = new Date(m.dueDate).getTime();
      const days = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
      if (days > DEADLINE_WARN_DAYS) continue;
      const todos = todosByMilestone.get(m._id.toString()) ?? [];
      if (todos.length === 0) continue;
      const incomplete = todos.filter((t) => t.status !== TodoStatus.DONE);
      const ratio = incomplete.length / todos.length;
      if (ratio < DEADLINE_MIN_OPEN_RATIO) continue;
      const severity =
        days <= 0
          ? OracleSeverity.CRITICAL
          : days <= DEADLINE_CRITICAL_DAYS
            ? OracleSeverity.CRITICAL
            : OracleSeverity.WARN;
      const mLabel = m.displayNumber ? `${m.displayNumber}: ${m.name}` : m.name;
      const incompletePct = Math.round(ratio * 100);
      const dueText = days < 0 ? `${Math.abs(days)} Tage überfällig` : `in ${days} Tagen fällig`;
      out.push({
        type: OracleRiskType.DEADLINE_PRESSURE,
        severity,
        title: `Milestone "${mLabel}" ${dueText} mit ${incompletePct}% offenen Quests`,
        reason:
          `Der Milestone hat eine Deadline am ${m.dueDate.toISOString().slice(0, 10)} (${dueText}). ` +
          `Von ${todos.length} verknüpften Todos sind ${incomplete.length} (${incompletePct}%) noch nicht "done". ` +
          `Ohne Eingriff droht ein Deadline-Miss oder Scope-Drift.`,
        recommendedAction:
          'Scope-Review: Quests priorisieren, niedrige Prios ausgliedern oder Milestone-Datum bewusst verschieben.',
        affectedEntities: [
          { entityType: 'milestone', entityId: m._id.toString(), label: mLabel },
          ...incomplete.slice(0, 10).map((t) => ({
            entityType: 'todo' as const,
            entityId: t._id.toString(),
            label: t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title,
          })),
        ],
        fingerprintExtra: `deadline_pressure|milestone:${m._id.toString()}`,
        metadata: { dueDate: m.dueDate, daysUntilDue: days, openRatio: ratio, openCount: incomplete.length },
      });
    }
    return out;
  }

  private detectBugHotspot(ctx: DetectorContext): DetectedSuggestion[] {
    const out: DetectedSuggestion[] = [];
    const cutoff = Date.now() - HOTSPOT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recentFailures = ctx.validationReports.filter(
      (r) =>
        (r.status === ValidationReportStatus.FAILED || r.status === ValidationReportStatus.ERROR) &&
        r.createdAt &&
        new Date(r.createdAt).getTime() >= cutoff,
    );
    if (recentFailures.length < HOTSPOT_MIN_FAILURES) return out;

    const groups = new Map<string, ValidationReportDocument[]>();
    for (const r of recentFailures) {
      // Group by command (preferred) or normalised name
      const key = (r.command || r.name || '').slice(0, 120).toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    for (const [key, group] of groups.entries()) {
      if (group.length < HOTSPOT_MIN_FAILURES) continue;
      const severity = group.length >= 6 ? OracleSeverity.CRITICAL : OracleSeverity.WARN;
      const affected: Array<{ entityType: KgEntityType; entityId: string; label?: string }> = group
        .slice(0, 10)
        .map((r) => ({
          entityType: 'validation_report' as const,
          entityId: r._id.toString(),
          label: r.name,
        }));
      // Add linked todos as additional context
      const todoIds = new Set<string>();
      for (const r of group) {
        if (r.todoId) todoIds.add(r.todoId.toString());
      }
      for (const tid of todoIds) {
        const t = ctx.todoById.get(tid);
        if (t) {
          affected.push({
            entityType: 'todo' as const,
            entityId: tid,
            label: t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title,
          });
        }
      }
      out.push({
        type: OracleRiskType.BUG_HOTSPOT,
        severity,
        title: `${group.length} Validierungs-Fehler in 7 Tagen für "${key.slice(0, 60)}"`,
        reason:
          `In den letzten ${HOTSPOT_WINDOW_DAYS} Tagen sind ${group.length} Validation-Reports mit Status "failed/error" ` +
          `für die gleiche Kommando-/Run-Signatur "${key}" eingelaufen. Das deutet auf instabilen Code, ` +
          `flaky Tests oder eine externe Infrastruktur-Störung hin.`,
        recommendedAction:
          'Logs der Reports prüfen, Root-Cause identifizieren. Wenn flaky → Test stabilisieren. Wenn echter Bug → ' +
          'Bug-Quest aus dem fehlerhaftesten Report (validation_report_propose_bug_todo) anlegen.',
        affectedEntities: affected,
        fingerprintExtra: `bug_hotspot|${key}`,
        metadata: { failures: group.length, command: key, windowDays: HOTSPOT_WINDOW_DAYS },
      });
    }
    return out;
  }

  private detectBlockerChain(ctx: DetectorContext): DetectedSuggestion[] {
    const out: DetectedSuggestion[] = [];
    // Build adjacency: todo -> todos it is blocked by
    const adj = new Map<string, string[]>();
    for (const t of ctx.todos) {
      const ids = (t.blockedBy ?? []).map((b) => b.toString());
      if (ids.length) adj.set(t._id.toString(), ids);
    }
    // For each open/in_progress/review todo, BFS the blocker chain
    for (const t of ctx.todos) {
      if (t.status === TodoStatus.DONE) continue;
      const start = t._id.toString();
      let depth = 0;
      const seen = new Set<string>([start]);
      let frontier = adj.get(start) ?? [];
      const chain: TodoDocument[] = [];
      while (frontier.length > 0 && depth < 10) {
        depth++;
        const next: string[] = [];
        for (const bid of frontier) {
          if (seen.has(bid)) continue;
          seen.add(bid);
          const b = ctx.todoById.get(bid);
          if (b) chain.push(b);
          for (const nb of adj.get(bid) ?? []) {
            if (!seen.has(nb)) next.push(nb);
          }
        }
        frontier = next;
      }
      if (depth < BLOCKER_CHAIN_WARN) continue;
      const severity = depth >= 5 ? OracleSeverity.CRITICAL : OracleSeverity.WARN;
      const label = t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title;
      out.push({
        type: OracleRiskType.BLOCKER_CHAIN,
        severity,
        title: `Quest "${label}" hängt an Blocker-Kette der Tiefe ${depth}`,
        reason:
          `Die Quest wird transitiv durch ${chain.length} weitere Todos blockiert (max. Tiefe ${depth}). ` +
          `Lange Blocker-Ketten verzögern die Auslieferung disproportional, weil jeder Blocker einzeln aufgelöst ` +
          `werden muss.`,
        recommendedAction:
          'Prüfen, ob die Kette wirklich notwendig ist oder ob Teile parallelisiert werden können. Ggf. den ' +
          'kritischen Pfad als eigenen Milestone abbilden.',
        affectedEntities: [
          { entityType: 'todo', entityId: start, label },
          ...chain.slice(0, 10).map((b) => ({
            entityType: 'todo' as const,
            entityId: b._id.toString(),
            label: b.displayNumber ? `${b.displayNumber}: ${b.title}` : b.title,
          })),
        ],
        fingerprintExtra: `blocker_chain|todo:${start}|depth:${depth}`,
        metadata: { depth, blockerCount: chain.length },
      });
    }
    return out;
  }

  // ---- Public API ---------------------------------------------------------

  async analyze(projectId: string): Promise<{
    discovered: number;
    inserted: number;
    refreshed: number;
    resolved: number;
  }> {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new BadRequestException(`Invalid projectId: ${projectId}`);
    }
    const filter = projectIdFilter(projectId);
    const [todos, milestones, validationReports] = await Promise.all([
      this.todoModel
        .find({ projectId: filter, archived: { $ne: true } })
        .select('title displayNumber tags milestoneId blockedBy status updatedAt')
        .exec(),
      this.milestoneModel
        .find({ projectId: filter, archived: { $ne: true } })
        .select('name displayNumber dueDate status changelogId archived')
        .exec(),
      this.validationReportModel
        .find({ projectId: filter })
        .select('name command status todoId createdAt')
        .sort({ createdAt: -1 })
        .limit(500)
        .exec(),
    ]);
    const todoById = new Map<string, TodoDocument>();
    for (const t of todos) todoById.set(t._id.toString(), t);

    const ctx: DetectorContext = { projectId, todos, milestones, validationReports, todoById };
    const detected: DetectedSuggestion[] = [
      ...this.detectStagnation(ctx),
      ...this.detectDeadlinePressure(ctx),
      ...this.detectBugHotspot(ctx),
      ...this.detectBlockerChain(ctx),
    ];

    const projectOid = new Types.ObjectId(projectId);
    let inserted = 0;
    let refreshed = 0;
    const seenFingerprints = new Set<string>();

    for (const d of detected) {
      const fingerprint = `${d.type}|${projectId}|${d.fingerprintExtra}`;
      seenFingerprints.add(fingerprint);
      try {
        const res = await this.suggestionModel.updateOne(
          { projectId: projectOid, fingerprint },
          {
            $setOnInsert: {
              projectId: projectOid,
              fingerprint,
              status: OracleSuggestionStatus.OPEN,
            },
            $set: {
              type: d.type,
              severity: d.severity,
              title: d.title,
              reason: d.reason,
              recommendedAction: d.recommendedAction,
              affectedEntities: d.affectedEntities,
              metadata: d.metadata,
            },
          },
          { upsert: true },
        );
        if (res.upsertedCount && res.upsertedCount > 0) inserted++;
        else refreshed++;
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          this.logger.warn(`Failed to upsert oracle suggestion: ${errorMessage(err)}`);
        }
      }
    }

    // Mark open suggestions that are no longer detected as "addressed"
    const stale = await this.suggestionModel
      .find({
        projectId: projectOid,
        status: OracleSuggestionStatus.OPEN,
        fingerprint: { $nin: Array.from(seenFingerprints) },
      })
      .exec();
    let resolved = 0;
    for (const s of stale) {
      s.status = OracleSuggestionStatus.ADDRESSED;
      await s.save();
      resolved++;
    }

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId,
      entity: 'oracle',
      action: 'updated',
      summary: `Oracle-Analyse: ${detected.length} Risiken, ${inserted} neu, ${resolved} behoben`,
    });

    return { discovered: detected.length, inserted, refreshed, resolved };
  }

  async list(query: ListOracleSuggestionsDto): Promise<OracleSuggestionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.status) filter.status = query.status;
    if (query.severity) filter.severity = query.severity;
    if (query.type) filter.type = query.type;
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const severityOrder = { critical: 0, warn: 1, info: 2 } as Record<string, number>;
    const all = await this.suggestionModel.find(filter).limit(limit * 2).exec();
    all.sort((a, b) => {
      const sa = severityOrder[a.severity] ?? 9;
      const sb = severityOrder[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return all.slice(0, limit);
  }

  async findById(id: string): Promise<OracleSuggestionDocument> {
    const s = await this.suggestionModel.findById(id).exec();
    if (!s) throw new NotFoundException(`OracleSuggestion ${id} not found`);
    return s;
  }

  async updateStatus(
    id: string,
    status: OracleSuggestionStatus,
    note?: string,
  ): Promise<OracleSuggestionDocument> {
    const s = await this.findById(id);
    s.status = status;
    if (note) {
      s.metadata = { ...(s.metadata ?? {}), statusNote: note };
    }
    await s.save();
    return s;
  }

  async commentOnTodo(
    id: string,
    dto: CommentOracleOnTodoDto = {},
  ): Promise<{ suggestion: OracleSuggestionDocument; todoId: string; commented: true }> {
    const suggestion = await this.findById(id);
    const targetTodoId =
      dto.todoId ??
      suggestion.affectedEntities.find((e) => e.entityType === 'todo')?.entityId;

    if (!targetTodoId || !Types.ObjectId.isValid(targetTodoId)) {
      throw new BadRequestException('Oracle suggestion has no affected todo; provide todoId explicitly');
    }

    const note = dto.note ? `\n\nNotiz: ${dto.note}` : '';
    await this.todosService.addComment(
      targetTodoId,
      `Oracle-Risiko ${suggestion.type} (${suggestion.severity}): ${suggestion.title}\n\n` +
        `${suggestion.reason}\n\nEmpfohlene Aktion: ${suggestion.recommendedAction ?? 'prüfen'}${note}`,
      'oracle',
    );

    suggestion.status = OracleSuggestionStatus.ADDRESSED;
    suggestion.metadata = {
      ...(suggestion.metadata ?? {}),
      commentedTodoId: targetTodoId,
      commentedAt: new Date().toISOString(),
    };
    await suggestion.save();
    return { suggestion, todoId: targetTodoId, commented: true };
  }

  async convertToTodo(
    id: string,
    overrides?: ConvertOracleToTodoDto,
  ): Promise<{ suggestion: OracleSuggestionDocument; todo: TodoDoc; reused: boolean }> {
    const suggestion = await this.findById(id);
    if (suggestion.status === OracleSuggestionStatus.CONVERTED_TO_TODO) {
      const existingId = suggestion.metadata?.todoId;
      if (typeof existingId === 'string' && Types.ObjectId.isValid(existingId)) {
        try {
          const existing = await this.todosService.findById(existingId);
          return { suggestion, todo: existing, reused: true };
        } catch {
          // fall through
        }
      }
    }
    if (
      suggestion.status !== OracleSuggestionStatus.OPEN &&
      suggestion.status !== OracleSuggestionStatus.CONVERTED_TO_TODO
    ) {
      throw new BadRequestException(
        `Cannot convert suggestion with status "${suggestion.status}" to a todo`,
      );
    }
    const title = (overrides?.title ?? `Oracle: ${suggestion.title}`).slice(0, 200);
    const entitiesList = suggestion.affectedEntities
      .slice(0, 10)
      .map((e) => `- ${e.entityType} \`${e.entityId}\`${e.label ? ` — ${e.label}` : ''}`)
      .join('\n');
    const description =
      `Auto-generiert aus Oracle-Risiko \`${suggestion._id.toString()}\` (Typ: ${suggestion.type}, Severity: ${suggestion.severity}).\n\n` +
      `**Begründung:**\n\n${suggestion.reason}\n\n` +
      (suggestion.recommendedAction
        ? `**Empfohlene Aktion:**\n\n${suggestion.recommendedAction}\n\n`
        : '') +
      (entitiesList ? `**Betroffene Entitäten:**\n\n${entitiesList}` : '');

    const todo = await this.todosService.create({
      projectId: suggestion.projectId.toString(),
      title,
      description,
      status: TodoStatus.OPEN,
      priority:
        (overrides?.priority as TodoPriority) ??
        (suggestion.severity === OracleSeverity.CRITICAL ? TodoPriority.HIGH : TodoPriority.MEDIUM),
      tags: overrides?.tags ?? ['oracle', suggestion.type],
      milestoneId: overrides?.milestoneId,
    });
    suggestion.status = OracleSuggestionStatus.CONVERTED_TO_TODO;
    suggestion.metadata = {
      ...(suggestion.metadata ?? {}),
      todoId: todo._id.toString(),
      todoCreatedAt: new Date().toISOString(),
    };
    await suggestion.save();
    return { suggestion, todo, reused: false };
  }

  async remove(id: string): Promise<void> {
    const res = await this.suggestionModel.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException(`OracleSuggestion ${id} not found`);
  }

  async removeByProject(projectId: string): Promise<void> {
    if (!Types.ObjectId.isValid(projectId)) return;
    await this.suggestionModel.deleteMany({ projectId: new Types.ObjectId(projectId) }).exec();
  }
}
