import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ResearchTopicService } from './research-topic.service';
import { ResearchArtifactService } from './research-artifact.service';
import { ResearchRunService, RunEvent } from './research-run.service';
import { ResearchAgentService } from './research-agent.service';
import { CreateResearchTopicDto, UpdateResearchTopicDto } from './dto/research-topic.dto';
import { WriteResearchArtifactDto } from './dto/write-artifact.dto';
import { ResearchRunDocument, ResearchRunStatus } from './schemas/research-run.schema';

/** `JwtAuthGuard` is wired globally (`app.module.ts`), so `req.user` is
 * already populated by the time a request reaches this controller — same
 * pattern as `auth.controller.ts`/`api-keys.controller.ts` (`req.user.userId`). */
interface AuthRequest extends Request {
  user?: { userId: string };
}

const TERMINAL_RUN_STATUSES = new Set<ResearchRunStatus>([
  ResearchRunStatus.DONE,
  ResearchRunStatus.ERROR,
  ResearchRunStatus.CANCELLED,
]);

/** Builds the SSE `done`/`error` event from a run's terminal DB state — used
 * both as the live bus event shape (`ResearchRunService.finalize`) and as a
 * synthesized fallback whenever this controller cannot rely on having
 * observed that bus event live (see `startRun`/`attachToRun`). */
function terminalEventFrom(run: {
  status: ResearchRunStatus;
  summary?: string;
  error?: string;
}): RunEvent {
  return {
    type: run.status === ResearchRunStatus.ERROR ? 'error' : 'done',
    status: run.status,
    summary: run.summary,
    error: run.error,
  };
}

/**
 * REST + SSE surface for the autonomous research agent: topic CRUD, run
 * history, live run streaming, and artifact CRUD.
 *
 * Routing choice: a single flat `@Controller()` (no class-level prefix)
 * hosting both `research-topics/...` and `research-runs/...` paths — mirrors
 * `MonitoringController`/`SshController`, which each host more than one
 * logical resource prefix in one controller rather than fragmenting a small
 * module across several controller classes.
 *
 * SSE handlers (`startRun`, `attachToRun`) follow the project's established
 * SSE-over-REST pattern EXACTLY: raw Express `@Res()`, the same four headers
 * + `flushHeaders()`, a guarded `send()`, a 15s `: ping` heartbeat, and an
 * `AbortController` wired to `req.on('close')`.
 */
@Controller()
export class ResearchAgentController {
  constructor(
    private readonly topicService: ResearchTopicService,
    private readonly artifactService: ResearchArtifactService,
    private readonly runService: ResearchRunService,
    private readonly agentService: ResearchAgentService,
  ) {}

  // ---------------------------------------------------------------------
  // Topics CRUD
  // ---------------------------------------------------------------------

  @Post('research-topics')
  @HttpCode(201)
  createTopic(@Body() dto: CreateResearchTopicDto, @Req() req: AuthRequest) {
    // `ownerUserId` MUST come from the authenticated caller, never the body
    // (the DTO has no such field on purpose — see research-topic.dto.ts).
    if (!req.user?.userId) throw new UnauthorizedException();
    return this.topicService.create(dto, req.user.userId);
  }

  @Get('research-topics')
  listTopics(@Query('active') active?: string, @Query('q') q?: string) {
    return this.topicService.list({
      active: active === undefined ? undefined : active === 'true',
      q,
    });
  }

  @Get('research-topics/:id')
  getTopic(@Param('id') id: string) {
    return this.topicService.get(id);
  }

  @Patch('research-topics/:id')
  updateTopic(@Param('id') id: string, @Body() dto: UpdateResearchTopicDto) {
    return this.topicService.update(id, dto);
  }

  @Delete('research-topics/:id')
  @HttpCode(204)
  async deleteTopic(@Param('id') id: string): Promise<void> {
    await this.topicService.remove(id);
  }

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  @Get('research-topics/:id/runs')
  listRuns(@Param('id') id: string) {
    return this.runService.listByTopic(id);
  }

  @Get('research-runs/:id')
  getRun(@Param('id') id: string) {
    return this.runService.getRun(id);
  }

  /**
   * Starts a manual research run and streams its progress.
   *
   * `ResearchAgentService.run()` creates its OWN `ResearchRun` document
   * internally (Task 13's `runInContext` → `runService.createRun`), but — as
   * of the T14 review fix — it also accepts an `onRunCreated` callback that
   * fires SYNCHRONOUSLY with the new run's id the instant that insert
   * resolves, strictly before the service can publish any `step`/`artifact`
   * event. This handler uses that callback to subscribe to the run's bus
   * channel deterministically: no discovery poll, no "guess which run just
   * appeared" — the runId this handler streams is guaranteed to be THIS
   * request's own run, and the subscription is guaranteed live before the
   * first step (see `ResearchAgentService.runInContext`). This handler still
   * ALWAYS emits a definitive terminal (`done`/`error`) event derived from
   * the run's final DB state once `agentService.run()` itself resolves,
   * unless the bus already delivered one for this exact run.
   *
   * A topic can have at most one active (non-terminal) run at a time — see
   * the `409` guard below — so the "two concurrent runs for one topic"
   * scenario the old discovery-poll code had to defend against (and could
   * still get wrong) cannot arise here in the first place.
   */
  @Post('research-topics/:id/runs')
  async startRun(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Validates the topic exists BEFORE any SSE header goes out, so a bad id
    // gets a normal JSON 404 instead of an SSE stream carrying an error line.
    await this.topicService.get(id);

    // Same reasoning for concurrency: a topic that already has an
    // active/non-terminal run gets a normal JSON 409 instead of a second SSE
    // stream that would race the first for control of a single topic (and,
    // pre-fix, could subscribe to the wrong run's bus channel entirely).
    const existingRuns = await this.runService.listByTopic(id);
    const activeRun = existingRuns.find(
      (r) => r.status === ResearchRunStatus.RUNNING || r.status === ResearchRunStatus.QUEUED,
    );
    if (activeRun) {
      res.status(409).json({
        message: `Topic ${id} already has an active run (#${activeRun.number})`,
        runId: activeRun._id.toString(),
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flushHeaders = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flushHeaders === 'function') flushHeaders.call(res);

    const send = (event: Record<string, unknown>): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    let unsubscribe: (() => void) | undefined;
    let terminalSent = false;

    try {
      const runPromise = this.agentService.run(id, 'manual', abort.signal, (runId) => {
        // Fires synchronously, before `agentService.run()` can publish
        // anything else — subscribing here means no step is ever missed.
        send({ type: 'run_started', runId, trigger: 'manual' });
        unsubscribe = this.runService.subscribe(runId, (event) => {
          send(event);
          if (event.type === 'done' || event.type === 'error') terminalSent = true;
        });
      });

      const finalRun = await runPromise;
      if (!terminalSent) {
        send(terminalEventFrom(finalRun));
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message || 'unknown error' });
    } finally {
      if (unsubscribe) unsubscribe();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Attaches to an existing run: replays its already-persisted `steps` as
   * `step` events, then either immediately reports the terminal status (if
   * the run has already finished) or subscribes for live updates until the
   * run reaches a terminal status or the client disconnects.
   *
   * Subscribe-before-read (T14 review fix): the OLD code read `run.steps`
   * ONCE up front and only subscribed afterwards, so a step appended in that
   * gap was neither in the snapshot nor caught by the (terminal-only)
   * re-fetch below — it was silently lost. This version subscribes FIRST,
   * buffering whatever arrives live into `buffered` instead of sending it,
   * THEN takes the `.steps` snapshot and replays it, THEN flushes the
   * buffer. Every live event is now delivered at least once — a step that
   * lands in both the snapshot and the buffer is delivered twice, an
   * acceptable rare duplicate for a live log (unlike loss).
   */
  @Get('research-runs/:id/stream')
  async attachToRun(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Validates the run exists BEFORE any SSE header goes out (same
    // reasoning as `startRun`'s topic check).
    await this.runService.getRun(id);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flushHeaders = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flushHeaders === 'function') flushHeaders.call(res);

    const send = (event: Record<string, unknown>): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    let unsubscribe: (() => void) | undefined;

    try {
      let buffering = true;
      const buffered: RunEvent[] = [];
      let terminalSeen = false;
      let resolveWait: (() => void) | undefined;

      // Subscribe FIRST — anything published from this point on is either
      // buffered (while `buffering`) or sent live (once flushed below), so
      // nothing published after this line can be lost.
      unsubscribe = this.runService.subscribe(id, (event) => {
        if (buffering) {
          buffered.push(event);
        } else {
          send(event);
        }
        if (event.type === 'done' || event.type === 'error') {
          terminalSeen = true;
          resolveWait?.();
        }
      });

      const run: ResearchRunDocument = await this.runService.getRun(id);
      for (const step of run.steps) {
        send({ type: 'step', step });
      }

      buffering = false;
      for (const event of buffered) {
        send(event);
      }
      buffered.length = 0;

      if (!terminalSeen) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          // The snapshot read above happened AFTER we subscribed, so if it
          // already shows a terminal status and the bus never delivered a
          // terminal event through our subscription, that event must have
          // fired before this handler even started (i.e. before subscribe
          // was possible) — synthesize it from the snapshot instead of
          // waiting forever for an event that will never come.
          send(terminalEventFrom(run));
        } else {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
            abort.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message || 'unknown error' });
    } finally {
      if (unsubscribe) unsubscribe();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  // ---------------------------------------------------------------------
  // Artifacts
  // ---------------------------------------------------------------------

  @Get('research-topics/:id/artifacts')
  listArtifacts(@Param('id') id: string) {
    return this.artifactService.listByTopic(id);
  }

  @Get('research-topics/:id/artifacts/:slug')
  async getArtifact(@Param('id') id: string, @Param('slug') slug: string) {
    const artifact = await this.artifactService.getBySlug(id, slug);
    if (!artifact) throw new NotFoundException(`Artifact "${slug}" not found for topic ${id}`);
    return artifact;
  }

  @Put('research-topics/:id/artifacts/:slug')
  async writeArtifact(
    @Param('id') id: string,
    @Param('slug') slug: string,
    @Body() dto: WriteResearchArtifactDto,
  ) {
    const topic = await this.topicService.get(id);
    return this.artifactService.write(id, { slug, ...dto }, topic.scope);
  }

  @Delete('research-topics/:id/artifacts/:slug')
  @HttpCode(204)
  async deleteArtifact(@Param('id') id: string, @Param('slug') slug: string): Promise<void> {
    await this.artifactService.remove(id, slug);
  }

  @Get('research-topics/:id/artifacts/:slug/versions')
  async listArtifactVersions(@Param('id') id: string, @Param('slug') slug: string) {
    const artifact = await this.artifactService.getBySlug(id, slug);
    if (!artifact) throw new NotFoundException(`Artifact "${slug}" not found for topic ${id}`);
    return this.artifactService.listVersions(artifact._id.toString());
  }
}
