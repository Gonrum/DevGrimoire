import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type QuestionDocument = HydratedDocument<Question>;

export type QuestionDirection = 'agent_to_user' | 'user_to_agent';
/**
 * Lifecycle status (T-394 extends the original three with):
 *  - `snoozed`    user deferred the question; scheduler wakes it up at snoozeUntil
 *  - `cancelled`  user / agent explicitly killed it (no answer needed)
 *  - `superseded` a newer question replaced this one (e.g. follow-up clarification)
 */
export type QuestionStatus =
  | 'pending'
  | 'answered'
  | 'expired'
  | 'snoozed'
  | 'cancelled'
  | 'superseded';

/**
 * Step in an escalation chain. When a question's wait window lapses the
 * scheduler walks forward to the next step, re-points the question at the
 * new audience and arms a fresh deadline.
 */
export type EscalationTargetKind = 'user' | 'role' | 'broadcast';

export interface EscalationStep {
  kind: EscalationTargetKind;
  /** When kind === 'user' */
  userId?: string;
  /** When kind === 'role' */
  role?: string;
  /** Milliseconds to wait at this step before progressing to the next one. */
  afterMs: number;
}

export interface EscalationHistoryEntry {
  step: number;
  appliedAt: Date;
  /** Snapshot of the resolved targets at the time of escalation, for audit. */
  resolvedTargetUserIds: string[];
}

/**
 * One response captured for a question. With broadcast/role targeting the
 * same question can receive several responses; the first one still wins for
 * `answer`/`answeredByUserId` (legacy fields), but every additional response
 * is appended here so the UI can surface "X and Y also responded".
 */
export interface QuestionResponse {
  userId?: string;
  username?: string;
  byAgent: boolean;
  answer: string;
  at: Date;
}

@Schema({ timestamps: true })
export class Question {
  @Prop({ required: true })
  question: string;

  @Prop({ type: [String], default: [] })
  options: string[];

  @Prop()
  context?: string;

  @Prop({ type: Types.ObjectId, ref: 'Todo' })
  todoId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  /**
   * Customer-scoped questions (M-45 / T-390). Mutually exclusive with
   * projectId in practice but stored independently so role/scope filters can
   * see customer-side traffic.
   */
  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  /** Originating research session (M-45 / T-390). Legacy research-sessions
   *  module was removed (T-22); field kept inert for existing data. */
  @Prop({ type: Types.ObjectId })
  researchSessionId?: Types.ObjectId;

  /** Originating chat session (M-45 / T-390). */
  @Prop({ type: Types.ObjectId, ref: 'ChatSession' })
  chatSessionId?: Types.ObjectId;

  /** Owning milestone if the question is tied to a milestone-level decision. */
  @Prop({ type: Types.ObjectId, ref: 'Milestone' })
  milestoneId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  targetUserId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  /**
   * 'agent_to_user' (default) — agent asks a user for input. Originates from
   * `ask_user` and stays visible after timeout so the user can still respond.
   * 'user_to_agent' — user-initiated follow-up question on a todo (T-247),
   * optionally even on completed todos.
   */
  @Prop({ type: String, enum: ['agent_to_user', 'user_to_agent'], default: 'agent_to_user', index: true })
  direction: QuestionDirection;

  /**
   * Optional metadata so multiple agents/runs can disambiguate which run a
   * pending question belongs to.
   */
  @Prop()
  agentRunId?: string;

  @Prop()
  agentName?: string;

  @Prop({
    type: String,
    enum: ['pending', 'answered', 'expired', 'snoozed', 'cancelled', 'superseded'],
    default: 'pending',
  })
  status: QuestionStatus;

  /** When a snoozed question should reappear in the pending list. */
  @Prop()
  snoozeUntil?: Date;

  /** Optional reason captured when cancelling or superseding. */
  @Prop()
  closeReason?: string;

  /** When superseded → points at the replacement Question. */
  @Prop({ type: Types.ObjectId, ref: 'Question' })
  supersededByQuestionId?: Types.ObjectId;

  /** Knowledge entry that captured the answer as a decision (T-391). */
  @Prop({ type: Types.ObjectId, ref: 'Knowledge' })
  decisionKnowledgeId?: Types.ObjectId;

  /** Todo created as a follow-up after this question was answered (T-391). */
  @Prop({ type: Types.ObjectId, ref: 'Todo' })
  followupTodoId?: Types.ObjectId;

  @Prop()
  answer?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  answeredByUserId?: Types.ObjectId;

  /** True when the answer was written by an agent (T-247 user→agent flow). */
  @Prop({ type: Boolean, default: false })
  answeredByAgent: boolean;

  @Prop()
  answeredAt?: Date;

  /**
   * Set after a successful convert-to-knowledge operation. Points to the
   * Knowledge entry that was created from this question's Q&A. Bidirectional
   * link: Knowledge.sourceQuestionId points back here.
   */
  @Prop({ type: Types.ObjectId, ref: 'Knowledge' })
  knowledgeId?: Types.ObjectId;

  /**
   * Soft-timeout. Questions whose `expiresAt` is in the past flip to status
   * 'expired' the next time `waitForAnswer` polls them, but the document is
   * NOT deleted — the user can still answer it from the todo detail view.
   * Optional: 'user_to_agent' questions don't have an automatic deadline.
   */
  @Prop({ default: 300000 })
  timeoutMs: number;

  @Prop()
  expiresAt?: Date;

  // ---- T-393 multi-target / escalation -------------------------------------

  /**
   * Role-based addressing. When set, every active user with this role and
   * project-scope access sees the question (in addition to a possibly set
   * targetUserId). Currently 'admin' | 'user' per UserRole enum.
   */
  @Prop()
  targetRole?: string;

  /**
   * Broadcast = every authenticated user with scope-access to the question's
   * project sees it. Mutually exclusive with the "no target at all" implicit-
   * broadcast default: legacy questions without targetUserId/targetRole still
   * surface for everyone (back-compat), but `broadcast=true` is the explicit
   * opt-in for new code.
   */
  @Prop({ default: false })
  broadcast: boolean;

  /**
   * Snapshot of resolved target user ids at create-time (or after each
   * escalation step). Empty array = "implicit broadcast" — every project
   * member sees it. Used by findPending and the per-user permission filter.
   */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  resolvedTargetUserIds: Types.ObjectId[];

  /**
   * Optional escalation chain. When the wait window lapses the scheduler
   * walks forward to the next step instead of marking the question expired.
   */
  @Prop({
    type: [{
      kind: { type: String, enum: ['user', 'role', 'broadcast'], required: true },
      userId: { type: String },
      role: { type: String },
      afterMs: { type: Number, required: true },
    }],
    default: [],
    _id: false,
  })
  escalationChain: EscalationStep[];

  /**
   * Index into `escalationChain` for the step that is currently armed.
   * 0 means "the initial target". After step N expires the scheduler bumps
   * this to N+1, re-resolves targets and recomputes expiresAt.
   */
  @Prop({ default: 0 })
  escalationStep: number;

  @Prop({
    type: [{
      step: { type: Number, required: true },
      appliedAt: { type: Date, required: true },
      resolvedTargetUserIds: { type: [String], default: [] },
    }],
    default: [],
    _id: false,
  })
  escalationHistory: EscalationHistoryEntry[];

  /**
   * Per-recipient response log. The first entry also stamps the legacy
   * `answer`/`answeredByUserId`/`answeredAt` fields (first-wins). Additional
   * responses are appended for audit when multiple recipients reply.
   */
  @Prop({
    type: [{
      userId: { type: String },
      username: { type: String },
      byAgent: { type: Boolean, default: false },
      answer: { type: String, required: true },
      at: { type: Date, default: () => new Date() },
    }],
    default: [],
    _id: false,
  })
  responses: QuestionResponse[];
}

export const QuestionSchema = SchemaFactory.createForClass(Question);
QuestionSchema.index({ status: 1, expiresAt: 1 });
QuestionSchema.index({ targetUserId: 1, status: 1 });
QuestionSchema.index({ todoId: 1, status: 1 });
QuestionSchema.index({ projectId: 1, status: 1 });
QuestionSchema.index({ direction: 1, status: 1, createdAt: -1 });
QuestionSchema.index({ resolvedTargetUserIds: 1, status: 1 });
QuestionSchema.index({ targetRole: 1, status: 1 });
QuestionSchema.index({ status: 1, snoozeUntil: 1 });
QuestionSchema.index({ customerId: 1, status: 1 });
QuestionSchema.index({ researchSessionId: 1, status: 1 });
QuestionSchema.index({ chatSessionId: 1, status: 1 });
QuestionSchema.index({ milestoneId: 1, status: 1 });
