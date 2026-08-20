import {
  Controller, Get, HttpException, Logger, Param, Query, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { KubeResourcesService } from './kube-resources.service';
import { KubeLogsService } from './kube-logs.service';
import { KubeAuditService } from './kube-audit.service';
import { EventsQueryDto, ListResourcesDto, ResourceParamsDto } from './dto/list-resources.dto';
import { LogsQueryDto } from './dto/logs-query.dto';
import { errorMessageWithCause } from '../common/narrow';

/** `req.user.userId` setzt der global registrierte JwtAuthGuard. */
interface AuthRequest {
  user?: { userId?: string };
}

/** Nur für die SSE-Route: Request-Close-Erkennung braucht die Express-Form. */
type StreamRequest = Request & AuthRequest;

/**
 * Lesende Cluster-Inhalte. Alle Routen sind read-only — schreibende Verben
 * kommen erst mit K3 und hängen dort an `readOnly: false`.
 *
 * T-477: Diese Routen prüfen NICHT, ob der Aufrufer für das Projekt des
 * Clusters berechtigt ist — dieselbe Lücke wie bei den SSH-Routen. Wenn die
 * Scope-Regel kommt, hakt sie hier ein, vor `resources.…`.
 */
@Controller('kube-clusters')
export class KubeResourcesController {
  private readonly logger = new Logger(KubeResourcesController.name);

  constructor(
    private readonly resources: KubeResourcesService,
    private readonly logs: KubeLogsService,
    private readonly audit: KubeAuditService,
  ) {}

  private userIdOf(req: AuthRequest): string {
    return req.user?.userId || 'system';
  }

  /**
   * `KubeResourcesService` wirft für einen Verbindungsfehler zum Cluster
   * (unerreichbarer Host, TLS-Fehler, DNS …) den rohen Fehler des generierten
   * Clients durch — meist ein `TypeError: fetch failed` aus undici, ohne
   * eigene Behandlung (verifiziert: ein Testlauf gegen einen unerreichbaren
   * Host landet unverändert im globalen Exception-Filter als 500 mit
   * Stacktrace). Das ist kein Bug im Service selbst zu beheben — er soll
   * echte Cluster-Antworten durchreichen, nicht raten, was ein Fehler
   * bedeutet. Die REST-Schicht hier entscheidet, was ein Caller sieht:
   * eine `HttpException` (400/404 aus `assertKind`/`clusters.findById`) ist
   * bereits ein sauberer Caller-Fehler und läuft unverändert durch; alles
   * andere ist ein Downstream-Problem (der Cluster, nicht der Aufruf) und
   * wird zu 503 statt eines rohen 500 — mit `errorMessageWithCause`, weil
   * undici das eigentlich Brauchbare (ENOTFOUND, ECONNREFUSED, TLS-Fehler)
   * in `.cause` trägt, nicht in `.message` (gleiches Muster wie
   * `KubeClientService.test()`).
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Nests eingebauter Filter loggt eine HttpException NICHT (das ist der
      // "behandelte" Pfad) — ohne diese Zeile wäre ein Verbindungsfehler zum
      // Cluster server-seitig unsichtbar, sobald er sauber auf 503
      // abgebildet ist. `warn` statt `error`, ohne Stacktrace: das ist ein zu
      // erwartender Zustand (falsch konfigurierter/nicht erreichbarer
      // Cluster), kein Backend-Bug — gleiches Muster wie
      // `KubeClientService.test()`.
      const message = errorMessageWithCause(err).slice(0, 500);
      this.logger.warn(`Kube-Ressourcenzugriff fehlgeschlagen: ${message}`);
      throw new ServiceUnavailableException(message);
    }
  }

  @Get(':id/namespaces')
  async namespaces(@Param('id') id: string, @Req() req: AuthRequest) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    const started = Date.now();
    const rows = await this.guarded(() => this.resources.listNamespaces(id));
    await this.audit.record({
      clusterId: id, action: 'list', sourceContext: 'ui',
      userId: this.userIdOf(req), resource: 'Namespace',
      durationMs: Date.now() - started,
    });
    return rows;
  }

  @Get(':id/resources')
  async list(@Param('id') id: string, @Query() q: ListResourcesDto, @Req() req: AuthRequest) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    const started = Date.now();
    const rows = await this.guarded(() => this.resources.list(id, q.kind, {
      namespace: q.namespace, labelSelector: q.labelSelector, limit: q.limit,
    }));
    await this.audit.record({
      clusterId: id, action: 'list', sourceContext: 'ui', userId: this.userIdOf(req),
      resource: q.kind, namespace: q.namespace, durationMs: Date.now() - started,
    });
    return rows;
  }

  @Get(':id/resources/:kind/:name')
  async get(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto, @Req() req: AuthRequest,
  ) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    const obj = await this.guarded(() => this.resources.get(id, kind, name, q.namespace));
    await this.audit.record({
      clusterId: id, action: 'get', sourceContext: 'ui', userId: this.userIdOf(req),
      resource: kind, namespace: q.namespace, name,
    });
    return obj;
  }

  @Get(':id/resources/:kind/:name/yaml')
  async yaml(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto,
  ) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    return { yaml: await this.guarded(() => this.resources.getYaml(id, kind, name, q.namespace)) };
  }

  @Get(':id/describe/:kind/:name')
  async describe(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto,
  ) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    return this.guarded(() => this.resources.describe(id, kind, name, q.namespace));
  }

  @Get(':id/events')
  async events(@Param('id') id: string, @Query() q: EventsQueryDto) {
    // T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
    return this.guarded(() => this.resources.events(id, {
      namespace: q.namespace, involvedName: q.involvedName, limit: q.limit,
    }));
  }

  /**
   * Log-Streaming als SSE. Kopfzeilen wie in chat.controller.ts — inklusive
   * `X-Accel-Buffering: no`, sonst puffert der nginx davor den Stream.
   *
   * T-477: hier hakt die Projekt-Scope-Prüfung ein, sobald sie existiert.
   *
   * Zwei Lehren aus dem Review von Task 4 (Log-Streaming-Service), beide
   * direkt in diesem Handler adressiert:
   *
   * 1. `KubeLogSession` hat keinen Fehlerkanal über `lines` selbst — ein
   *    Verbindungsabbruch während `follow` beendet `lines` sauber (`stream.
   *    end()`, nicht `.destroy()`), nicht mit einem Reject. Ohne den
   *    `session.error()`-Check unten läse der Client ein sauberes "done",
   *    obwohl das Log mittendrin abgerissen ist — genau während eines
   *    Incidents. `KubeLogsService` wurde deshalb um `error()` erweitert
   *    (kube-logs.service.ts), gepinnt durch einen neuen Fall in
   *    kube-logs-check.cjs (16. Fall).
   * 2. `close()` gibt den Transport frei, lässt aber bereits gepufferte
   *    Zeilen (laut Review ca. 18 KB) noch abfliessen — der `for await`
   *    läuft also kurz weiter, nachdem der Client weg ist. Jeder Schreib-
   *    zugriff unten ist deshalb auf `res.writableEnded` gewacht statt
   *    anzunehmen, `close()` stoppe die Iteration sofort.
   */
  @Get(':id/logs/stream')
  async logStream(
    @Param('id') id: string, @Query() q: LogsQueryDto,
    @Req() req: StreamRequest,
    @Res() res: Response,
  ): Promise<void> {
    const started = Date.now();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let session: Awaited<ReturnType<KubeLogsService['open']>> | undefined;
    try {
      session = await this.logs.open(id, q.namespace, q.pod, {
        container: q.container, tailLines: q.tailLines,
        previous: q.previous, follow: q.follow, sinceSeconds: q.sinceSeconds,
      });
    } catch (err) {
      // errorMessageWithCause statt errorMessage: undici packt das
      // eigentlich Brauchbare (ENOTFOUND, ECONNREFUSED, TLS-Fehler) in
      // `.cause`, nicht in `.message` — gleiches Muster wie `guarded()` oben
      // und `KubeClientService.test()`. Anders als bei einem Stream-Fehler
      // NACH dem Öffnen (den `KubeLogsService` selbst schon loggt) hat hier
      // noch niemand geloggt — dieser Pfad ist der einzige Fehlerfall vor
      // dem ersten Event.
      const message = errorMessageWithCause(err).slice(0, 500);
      this.logger.warn(`Log-Stream konnte nicht geöffnet werden (${id}): ${message}`);
      send({ type: 'error', message });
      if (!res.writableEnded) res.end();
      return;
    }

    // Geht der Client, wird der Cluster-Stream abgebrochen und der Transport
    // freigegeben. Ohne das läuft ein `follow`-Stream weiter, obwohl ihn
    // niemand mehr liest — `close()` selbst ist mehrfach aufrufbar, das
    // spätere `session.close()` im `finally` unten ist also kein Problem.
    req.on('close', () => session?.close());

    try {
      for await (const line of session.lines) {
        // `close()` beendet `lines` nicht sofort (bereits gepufferte Zeilen
        // fliessen noch ab) — jeder Schreibzugriff bleibt deshalb auf
        // `res.writableEnded` gewacht, sonst schreibt dieser Handler auf
        // eine bereits beendete Antwort.
        if (res.writableEnded) break;
        send({ type: 'line', line });
      }
      // `lines` endet nach einem Verbindungsabbruch genauso sauber wie nach
      // einem regulären Ende (siehe JSDoc oben) — `session.error()` ist die
      // einzige Stelle, an der sich das nachträglich unterscheiden lässt.
      const streamError = session.error();
      if (streamError) {
        send({ type: 'error', message: streamError });
      } else {
        send({ type: 'done' });
      }
    } catch (err) {
      send({ type: 'error', message: errorMessageWithCause(err).slice(0, 500) });
    } finally {
      session.close();
      if (!res.writableEnded) res.end();
      await this.audit.record({
        clusterId: id, action: 'logs', sourceContext: 'ui', userId: this.userIdOf(req),
        resource: 'Pod', namespace: q.namespace, name: q.pod,
        durationMs: Date.now() - started,
      });
    }
  }
}
