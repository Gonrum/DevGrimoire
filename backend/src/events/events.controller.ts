import { Controller, Logger, Query, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, filter, map, merge } from 'rxjs';
import { EventsBusService } from './events-bus.service';

interface MessageEvent {
  data: string;
}

/**
 * Legacy SSE endpoint. Kept for backwards-compat with any tool that may still
 * subscribe to /api/events. First-party UI moved to the WebSocket multiplex
 * endpoint at /api/ws/events (see main.ts) which avoids the HTTP/1.1
 * 6-connections-per-origin limit when multiple tabs are open.
 */
@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(private readonly bus: EventsBusService) {}

  @Sse()
  sse(
    @Req() req: Request,
    @Query('projectId') projectId?: string,
    @Query('userId') queryUserId?: string,
  ): Observable<MessageEvent> {
    this.logger.warn(
      `Deprecated SSE /api/events used (UA="${req.headers['user-agent'] || ''}"). Migrate to /api/ws/events.`,
    );
    const authedUserId =
      (req as Request & { user?: { userId?: string } }).user?.userId || queryUserId;

    const projectEvents$ = this.bus.events$.pipe(
      filter((event) => {
        if (event.userId) {
          return !!authedUserId && event.userId === authedUserId;
        }
        if (event.entity === 'notification') return true;
        if (event.projectId === null) return true;
        if (projectId) return event.projectId === projectId;
        return event.entity === 'project';
      }),
      map((event) => ({ data: JSON.stringify(event) })),
    );

    const questionStream$ = this.bus.questionEvents$.pipe(
      filter((event) => {
        if (!event.targetUserId) return true;
        if (authedUserId) return event.targetUserId === authedUserId;
        return true;
      }),
      map((event) => ({ data: JSON.stringify(event) })),
    );

    return merge(projectEvents$, questionStream$);
  }
}
