import { Controller, ForbiddenException, Logger, Query, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, filter, map, merge } from 'rxjs';
import { EventsBusService } from './events-bus.service';
import { AuthRequest } from '../common/request-context';
import { actorCanAccessProject } from '../common/permissions';
import { isProjectEventVisible, isQuestionEventVisible } from './event-visibility';

interface MessageEvent {
  data: string;
}

/**
 * Legacy SSE endpoint. Kept for backwards-compat with any tool that may still
 * subscribe to /api/events. First-party UI moved to the WebSocket multiplex
 * endpoint at /api/ws/events (see main.ts) which avoids the HTTP/1.1
 * 6-connections-per-origin limit when multiple tabs are open.
 *
 * H-13: Die Route nahm `userId` als Query-Fallback und `projectId` ungeprüft
 * aus dem Query-String. `?userId=` ist ersatzlos entfallen — die Identität
 * kommt nur aus der Authentifizierung —, `projectId` wird gegen den Scope des
 * Actors geprüft, und jedes Event läuft durch dieselbe Sichtbarkeitsregel wie
 * im WebSocket-Pfad (event-visibility.ts).
 */
@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(private readonly bus: EventsBusService) {}

  @Sse()
  sse(
    @Req() req: Request & AuthRequest,
    @Query('projectId') projectId?: string,
  ): Observable<MessageEvent> {
    this.logger.warn(
      `Deprecated SSE /api/events used (UA="${req.headers['user-agent'] || ''}"). Migrate to /api/ws/events.`,
    );
    const actor = req.user;
    const userId = actor?.userId;
    if (projectId && actor && !actorCanAccessProject(actor, projectId)) {
      throw new ForbiddenException('Kein Zugriff auf dieses Projekt');
    }

    const projectEvents$ = this.bus.events$.pipe(
      filter((event) => {
        if (!isProjectEventVisible(event, userId, actor)) return false;
        if (event.userId) return true;
        if (event.entity === 'notification') return true;
        if (event.projectId === null) return true;
        if (projectId) return event.projectId === projectId;
        return event.entity === 'project';
      }),
      map((event) => ({ data: JSON.stringify(event) })),
    );

    const questionStream$ = this.bus.questionEvents$.pipe(
      filter((event) => isQuestionEventVisible(event, userId, actor)),
      map((event) => ({ data: JSON.stringify(event) })),
    );

    return merge(projectEvents$, questionStream$);
  }
}
