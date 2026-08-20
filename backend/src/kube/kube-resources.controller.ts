import {
  Controller, Get, HttpException, Logger, Param, Query, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { KubeResourcesService } from './kube-resources.service';
import { KubeLogsService } from './kube-logs.service';
import { KubeAuditService } from './kube-audit.service';
import { KubeClustersService } from './kube-clusters.service';
import { EventsQueryDto, ListResourcesDto, ResourceParamsDto } from './dto/list-resources.dto';
import { LogsQueryDto } from './dto/logs-query.dto';
import { errorMessageWithCause, isRecord } from '../common/narrow';

/** `req.user.userId` setzt der global registrierte JwtAuthGuard. */
interface AuthRequest {
  user?: { userId?: string };
}

/** Nur für die SSE-Route: Request-Close-Erkennung braucht die Express-Form. */
type StreamRequest = Request & AuthRequest;

/**
 * `@kubernetes/client-node`s `ApiException` (gen/apis/exception.js) trägt den
 * echten HTTP-Status der Cluster-API in `.code` — kein Nest-`HttpException`,
 * also unsichtbar für `err instanceof HttpException`. Ohne diese Erkennung
 * landete jedes Cluster-4xx (Pod nicht gefunden, RBAC verweigert, Token
 * abgelaufen) hinter einem 503 "cluster unavailable" — genau während des
 * Incidents, in dem diese Unterscheidung zählt (Review-Fund, Important 3).
 *
 * Kein Cast: `isRecord` verengt zur Laufzeit, keine Behauptung nötig.
 */
function kubeApiExceptionCode(err: unknown): number | undefined {
  return isRecord(err) && typeof err.code === 'number' ? err.code : undefined;
}

/**
 * `ApiException.message` ist der mehrzeilige Debug-String aus ihrem
 * Konstruktor ("HTTP-Code: 500\nMessage: …\nBody: …\nHeaders: …") — nicht
 * das, was ein Caller lesen soll. `.body` trägt bei einem echten
 * Cluster-Fehler die Kubernetes-`Status`, deren `.message` lesbar ist
 * ("pods \"foo\" not found"); die wird bevorzugt, wenn vorhanden.
 */
function kubeApiExceptionMessage(err: unknown): string {
  if (isRecord(err) && isRecord(err.body) && typeof err.body.message === 'string') {
    return err.body.message;
  }
  return errorMessageWithCause(err);
}

const TRANSPORT_CAUSE_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH',
]);

/** Node-Fehlercode einer `.cause`-Kette, sofern vorhanden — wie `mongoErrorCode` in narrow.ts. */
function causeErrorCode(err: unknown): string | undefined {
  if (!isRecord(err) || !isRecord(err.cause)) return undefined;
  return typeof err.cause.code === 'string' ? err.cause.code : undefined;
}

/**
 * Erkennt eine Downstream-/Transport-Störung (Cluster nicht erreichbar,
 * DNS/TLS-Fehler) statt eines echten Bugs im eigenen Code. undici wirft für
 * einen fehlgeschlagenen `fetch()` immer denselben äusseren
 * `TypeError: fetch failed` und packt das eigentlich Brauchbare in `.cause`
 * (ENOTFOUND, ECONNREFUSED, TLS-Meldungen) — dasselbe Muster, das
 * `errorMessageWithCause` an anderer Stelle (`KubeClientService.test()`)
 * schon auswertet.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  const causeCode = causeErrorCode(err);
  if (causeCode && TRANSPORT_CAUSE_CODES.has(causeCode)) return true;
  return /certificate|TLS|SSL/i.test(errorMessageWithCause(err));
}

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
    private readonly clusters: KubeClustersService,
  ) {}

  private userIdOf(req: AuthRequest): string {
    return req.user?.userId || 'system';
  }

  /**
   * `KubeResourcesService` lässt jeden Fehler unverändert durch — sie soll
   * echte Cluster-Antworten durchreichen, nicht raten, was ein Fehler
   * bedeutet. Diese REST-Schicht entscheidet, was ein Caller sieht, in drei
   * Stufen:
   *
   * 1. Bereits eine `HttpException` (400/404 aus `assertKind`/
   *    `clusters.findById`) — unverändert durch, das ist schon ein sauberer
   *    Caller-Fehler.
   * 2. Ein Cluster-eigenes 4xx (`ApiException` mit `.code` 400..499 — Pod
   *    nicht gefunden, RBAC verweigert, Token abgelaufen) — als
   *    `HttpException` mit demselben Code durchgereicht. Ein 503 wäre hier
   *    irreführend: das ist kein Downstream-Ausfall, sondern eine Antwort
   *    vom Cluster.
   * 3. Ein Transport-Problem (`ApiException` mit `.code >= 500`, oder eine
   *    erkannte Verbindungsstörung — `fetch failed`, ENOTFOUND, ECONNREFUSED,
   *    TLS) — 503 statt eines rohen 500, mit `warn`-Log (kein Bug, ein zu
   *    erwartender Zustand, gleiches Muster wie `KubeClientService.test()`).
   *
   * Alles andere — weder ein erkanntes Cluster-4xx noch ein erkanntes
   * Transport-Problem — läuft UNVERÄNDERT durch. Das ist mit Absicht kein
   * Catch-all: Nests eingebauter Filter loggt eine `HttpException` NICHT
   * (das ist der "behandelte" Pfad), also würde ein echter Bug im eigenen
   * Code hinter einem sauberen 503 verschwinden, ohne Stacktrace — genau die
   * eine Fehlerklasse, die ihn braucht (Review-Fund, Important 3).
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;

      const apiCode = kubeApiExceptionCode(err);
      if (apiCode !== undefined && apiCode >= 400 && apiCode < 500) {
        throw new HttpException(kubeApiExceptionMessage(err), apiCode);
      }

      if ((apiCode !== undefined && apiCode >= 500) || isTransportFailure(err)) {
        const message = kubeApiExceptionMessage(err).slice(0, 500);
        this.logger.warn(`Kube-Ressourcenzugriff fehlgeschlagen: ${message}`);
        throw new ServiceUnavailableException(message);
      }

      throw err;
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
   * Lehren aus zwei Reviews, alle direkt in diesem Handler adressiert:
   *
   * 1. `KubeLogSession` hat keinen Fehlerkanal über `lines` selbst — ein
   *    Verbindungsabbruch während `follow` beendet `lines` sauber (`stream.
   *    end()`, nicht `.destroy()`), nicht mit einem Reject. Ohne den
   *    `session.error()`-Check unten läse der Client ein sauberes "done",
   *    obwohl das Log mittendrin abgerissen ist. `KubeLogsService` wurde
   *    deshalb um `error()` erweitert (kube-logs.service.ts).
   * 2. `close()` gibt den Transport frei, lässt aber bereits gepufferte
   *    Zeilen noch abfliessen — der `for await` läuft also kurz weiter,
   *    nachdem der Client weg ist. Jeder Schreibzugriff unten ist deshalb
   *    auf `res.writableEnded`/`clientGone` gewacht statt anzunehmen,
   *    `close()` stoppe die Iteration sofort.
   * 3. (Review-Fund, Critical 1) `EventSource` kann keine Header setzen —
   *    `?token=` ist der einzige Weg, wie ein Browser diese Route
   *    authentifiziert aufruft. `LogsQueryDto.token` existiert nur deshalb:
   *    der Guard kopiert ihn in den Authorization-Header, lässt den
   *    Query-Parameter aber stehen, und die globale `ValidationPipe`
   *    (`forbidNonWhitelisted: true`) hätte ihn sonst als unbekanntes Feld
   *    abgelehnt, bevor der Guard ihn je sieht.
   * 4. (Review-Fund, Critical 2) `req.on('close', …)` MUSS registriert sein,
   *    BEVOR `open()` awaited wird. `'close'` feuert genau einmal;
   *    passierte das während `open()` noch am Tunnel/API-Server hängt, hätte
   *    ein erst danach registrierter Listener dieses Ereignis nie gesehen —
   *    `res.writableEnded` wird ausschliesslich durch unser EIGENES
   *    `res.end()` wahr, ein verschwundener Client setzt es nicht. Ein
   *    `follow`-Stream liefe dann bis zum Ende der Pod-Ausgabe weiter, ohne
   *    dass ihn noch jemand liest, und hielte Cluster-Verbindung und
   *    Transport-Lease für immer. `clientGone` ist deshalb der zusätzliche
   *    Flag, den `writableEnded` allein nicht liefert.
   * 5. (Review-Fund, Important 4) Der Cluster wird VOR dem ersten
   *    `setHeader` aufgelöst (`clusters.findById`) — ein unbekannter/
   *    ungültiger Cluster bekommt eine saubere JSON-Antwort (400/404) statt
   *    eines halb geöffneten SSE-Streams. Gleiches Muster wie
   *    `workspaces.controller.ts` (`execStream`).
   * 6. (Review-Fund, Minor) Heartbeat alle 15s wie `chat.controller.ts` —
   *    ein ruhiger `follow`-Stream produziert sonst minutenlang nichts und
   *    nginx' `proxy_read_timeout` (Default 60s) kappt die Verbindung, ohne
   *    dass der Client je `done` oder `error` sieht.
   */
  @Get(':id/logs/stream')
  async logStream(
    @Param('id') id: string, @Query() q: LogsQueryDto,
    @Req() req: StreamRequest,
    @Res() res: Response,
  ): Promise<void> {
    const started = Date.now();

    // Fix 5 (s.o.): VOR dem ersten setHeader. Wirft `clusters.findById` (400
    // ungültige Id, 404 unbekannter Cluster), ist noch keine Response-Zeile
    // geschrieben — Nests Filter liefert ein sauberes JSON, kein halb
    // geöffneter SSE-Stream.
    await this.clusters.findById(id);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Fix 6 (s.o.): dieselbe Stelle, an der der Handler die Session
    // schliesst, räumt auch den Heartbeat ab — beides im äusseren `finally`.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    let session: Awaited<ReturnType<KubeLogsService['open']>> | undefined;
    // Fix 4 (s.o.): registriert VOR dem `await this.logs.open(...)` unten,
    // nicht danach. `session` ist zu diesem Zeitpunkt noch undefined, falls
    // der Client geht, während `open()` selbst noch läuft — `session?.close()`
    // ist dann ein No-Op, deshalb der `clientGone`-Nachtrag direkt nach dem
    // `await`.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      session?.close();
    });

    try {
      try {
        session = await this.logs.open(id, q.namespace, q.pod, {
          container: q.container, tailLines: q.tailLines,
          previous: q.previous, follow: q.follow, sinceSeconds: q.sinceSeconds,
        });
      } catch (err) {
        // kubeApiExceptionMessage statt eines rohen errorMessageWithCause:
        // dieselbe Behandlung wie in guarded() oben — ein `ApiException`
        // aus `Log.log()` (z.B. "HTTP-Code: 500\n…") wird sonst wörtlich an
        // den Client gereicht. Anders als bei einem Stream-Fehler NACH dem
        // Öffnen (den `KubeLogsService` selbst schon loggt) hat hier noch
        // niemand geloggt.
        const message = kubeApiExceptionMessage(err).slice(0, 500);
        this.logger.warn(`Log-Stream konnte nicht geöffnet werden (${id}): ${message}`);
        send({ type: 'error', message });
        return;
      }

      // Der Client kann schon während open() gegangen sein (s.o., Fix 4) —
      // `session` ist jetzt zwar offen, aber niemand liest mehr. Der
      // Listener oben hat `close()` bereits versucht (war zu dem Zeitpunkt
      // noch ein No-Op über `?.`); das wird hier nachgeholt.
      if (clientGone) {
        session.close();
        return;
      }

      try {
        for await (const line of session.lines) {
          // `close()` beendet `lines` nicht sofort (bereits gepufferte
          // Zeilen fliessen noch ab), und `res.writableEnded` wird nur durch
          // unser EIGENES `res.end()` wahr — ein verschwundener Client
          // setzt es nicht (Fix 4/Critical 2). `clientGone` ist deshalb Teil
          // der Abbruchbedingung, nicht nur `writableEnded`.
          if (clientGone || res.writableEnded) break;
          send({ type: 'line', line });
        }
        // `lines` endet nach einem Verbindungsabbruch genauso sauber wie
        // nach einem regulären Ende (siehe JSDoc oben) — `session.error()`
        // ist die einzige Stelle, an der sich das nachträglich
        // unterscheiden lässt.
        const streamError = session.error();
        if (streamError) {
          send({ type: 'error', message: streamError });
        } else {
          send({ type: 'done' });
        }
      } catch (err) {
        send({ type: 'error', message: kubeApiExceptionMessage(err).slice(0, 500) });
      } finally {
        session.close();
        await this.audit.record({
          clusterId: id, action: 'logs', sourceContext: 'ui', userId: this.userIdOf(req),
          resource: 'Pod', namespace: q.namespace, name: q.pod,
          durationMs: Date.now() - started,
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}
