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
import { KubeAuditSourceContext } from './schemas/kube-audit.schema';
import { isRecord } from '../common/narrow';
import { kubeApiExceptionCode, kubeApiExceptionMessage } from './kube-errors';

/**
 * `req.user` setzt der global registrierte JwtAuthGuard.
 *
 * `apiKeyId` ist dabei die Unterscheidung, die dieses Modul für den Audit
 * braucht: der Guard setzt es AUSSCHLIESSLICH auf dem API-Key-Zweig
 * (`request.user = { …, apiKeyId: validated._id.toString() }`), der
 * JWT-Zweig lässt es leer. Kein neuer Mechanismus, kein Header-Raten.
 */
interface AuthRequest {
  user?: { userId?: string; apiKeyId?: string };
}

/** Nur für die SSE-Route: Request-Close-Erkennung braucht die Express-Form. */
type StreamRequest = Request & AuthRequest;


/** So lange darf ein SSE-Client beim Log-Stream nichts abnehmen (M-17). */
const LOG_STREAM_DRAIN_TIMEOUT_MS = 30_000;

/**
 * true, sobald `res` wieder Platz hat; false bei Verbindungsende oder wenn
 * nach `timeoutMs` noch immer nichts abgeflossen ist.
 */
export function waitForDrain(
  res: Pick<Response, 'once' | 'off'>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

const TRANSPORT_CAUSE_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH',
  // TLS/Zertifikatsfehler: OpenSSL-Verifikationsfehler tragen einen dieser
  // stabilen Codes in `.cause.code` (Review-Fund, Runde 2) — kein Textmuster
  // nötig, und keins mehr erwünscht (siehe JSDoc unten).
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
]);

/** Node-Fehlercode einer `.cause`-Kette, sofern vorhanden — wie `mongoErrorCode` in narrow.ts. */
function causeErrorCode(err: unknown): string | undefined {
  if (!isRecord(err) || !isRecord(err.cause)) return undefined;
  return typeof err.cause.code === 'string' ? err.cause.code : undefined;
}

/**
 * Erkennt eine Downstream-/Transport-Störung (Cluster nicht erreichbar,
 * DNS/TLS-Fehler) statt eines echten Bugs im eigenen Code. undici wirft für
 * einen fehlgeschlagenen `fetch()` — `@kubernetes/client-node` v2 geht immer
 * darüber, auch für TLS-Fehler — denselben äusseren `TypeError: fetch
 * failed` und packt das eigentlich Brauchbare in `.cause` (ENOTFOUND,
 * ECONNREFUSED, TLS-Codes) — dasselbe Muster, das `errorMessageWithCause`
 * an anderer Stelle (`KubeClientService.test()`) schon auswertet.
 *
 * KEIN Textmuster-Fallback (Review-Fund, Runde 2 — vorher stand hier ein
 * `/certificate|TLS|SSL/i`-Test auf der zusammengesetzten Meldung): dieses
 * Modul hat lebende Bezeichner wie `skipTLSVerify`, `tlsServerName`,
 * `allowInsecureTls` — ein `TypeError: Cannot read properties of undefined
 * (reading 'skipTLSVerify')`, ein echter Bug im eigenen Code, hätte
 * gematcht und wäre als `warn`-geloggtes 503 OHNE Stacktrace verschwunden —
 * exakt die Fehlerklasse, die Stufe 3 (raw rethrow) erhalten soll. Der
 * Regex kaufte dafür nichts ein: TLS-Fehler kommen ohnehin schon über den
 * `fetch failed`-Zweig oben an, und die stabilen `.cause.code`-Werte oben
 * decken den Rest strukturell ab.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  const causeCode = causeErrorCode(err);
  return causeCode !== undefined && TRANSPORT_CAUSE_CODES.has(causeCode);
}

/**
 * Lesende Cluster-Inhalte. Alle Routen sind read-only — schreibende Verben
 * kommen erst mit K3 und hängen dort an `readOnly: false`.
 *
 * T-477: Die Projekt-/Kunden-Scope-Prüfung läuft in
 * `KubeClustersService.findById()` bzw. `findBySlug()`. Jede Route hier löst
 * den Cluster darüber auf, bevor sie `resources.…` aufruft — bewusst nicht pro
 * Route, damit eine neue Route den Check nicht vergessen kann. Noch offen:
 * die HTTP-MCP-Achse (die MCP-Middleware hängt einen Actor ohne Scope-Felder
 * an, `projectScopeMode ?? 'all'` lässt einen verengten API-Key durch) und das
 * SSH-Modul, das gar keine Scope-Prüfung kennt.
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
   * Woher der Aufruf kam. `'ui'` hiess vorher fest „REST-Controller", was den
   * Wert wertlos machte: ein Aufruf mit API-Key (Skript, CI, fremdes Tool)
   * wurde als Browser-Verkehr protokolliert, und die `'rest'`-Zeilen von K1s
   * `KubeClientService.test()` standen daneben wie eine andere Quelle. Die
   * Unterscheidung ist die, die der `JwtAuthGuard` ohnehin schon trifft —
   * `apiKeyId` gibt es nur auf dem API-Key-Zweig.
   */
  private sourceOf(req: AuthRequest): KubeAuditSourceContext {
    return req.user?.apiKeyId ? 'rest' : 'ui';
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
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const rows = await this.guarded(() => this.resources.listNamespaces(id));
    await this.audit.record({
      clusterId: id, action: 'list', sourceContext: this.sourceOf(req),
      userId: this.userIdOf(req), resource: 'Namespace',
      durationMs: Date.now() - started,
    });
    return rows;
  }

  @Get(':id/resources')
  async list(@Param('id') id: string, @Query() q: ListResourcesDto, @Req() req: AuthRequest) {
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const rows = await this.guarded(() => this.resources.list(id, q.kind, {
      namespace: q.namespace, labelSelector: q.labelSelector, limit: q.limit,
    }));
    await this.audit.record({
      clusterId: id, action: 'list', sourceContext: this.sourceOf(req), userId: this.userIdOf(req),
      resource: q.kind, namespace: q.namespace, durationMs: Date.now() - started,
    });
    return rows;
  }

  @Get(':id/resources/:kind/:name')
  async get(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto, @Req() req: AuthRequest,
  ) {
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const obj = await this.guarded(() => this.resources.get(id, kind, name, q.namespace));
    await this.audit.record({
      clusterId: id, action: 'get', sourceContext: this.sourceOf(req), userId: this.userIdOf(req),
      resource: kind, namespace: q.namespace, name, durationMs: Date.now() - started,
    });
    return obj;
  }

  @Get(':id/resources/:kind/:name/yaml')
  async yaml(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto, @Req() req: AuthRequest,
  ) {
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const yaml = await this.guarded(() => this.resources.getYaml(id, kind, name, q.namespace));
    // Auditiert wie jeder andere Read (Review-Fund I2): diese Route liest
    // dasselbe Objekt wie `get` — dass sie es als YAML statt als JSON
    // zurückgibt, macht sie nicht weniger protokollierenswert. Ausgerechnet
    // hier fehlte die Zeile, obwohl der Weg der ist, über den man ein Secret
    // ansieht.
    await this.audit.record({
      clusterId: id, action: 'get', sourceContext: this.sourceOf(req), userId: this.userIdOf(req),
      resource: kind, namespace: q.namespace, name, durationMs: Date.now() - started,
    });
    return { yaml };
  }

  @Get(':id/describe/:kind/:name')
  async describe(
    @Param('id') id: string, @Param('kind') kind: string, @Param('name') name: string,
    @Query() q: ResourceParamsDto, @Req() req: AuthRequest,
  ) {
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const result = await this.guarded(() => this.resources.describe(id, kind, name, q.namespace));
    await this.audit.record({
      clusterId: id, action: 'get', sourceContext: this.sourceOf(req), userId: this.userIdOf(req),
      resource: kind, namespace: q.namespace, name, durationMs: Date.now() - started,
    });
    return result;
  }

  @Get(':id/events')
  async events(@Param('id') id: string, @Query() q: EventsQueryDto, @Req() req: AuthRequest) {
    // T-477: Scope-Prüfung läuft in KubeClustersService.findById().
    const started = Date.now();
    const rows = await this.guarded(() => this.resources.events(id, {
      namespace: q.namespace, involvedName: q.involvedName,
      involvedKind: q.involvedKind, limit: q.limit,
    }));
    await this.audit.record({
      clusterId: id, action: 'list', sourceContext: this.sourceOf(req), userId: this.userIdOf(req),
      resource: 'Event', namespace: q.namespace, name: q.involvedName,
      durationMs: Date.now() - started,
    });
    return rows;
  }

  /**
   * Log-Streaming als SSE. Kopfzeilen wie in chat.controller.ts — inklusive
   * `X-Accel-Buffering: no`, sonst puffert der nginx davor den Stream.
   *
   * T-477: Scope-Prüfung läuft in `KubeClustersService.findById()` — dieser
   * Handler ruft sie explizit VOR dem ersten `setHeader` auf (siehe Fix 5
   * unten), und `KubeLogsService.open()` tut es für den eigentlichen Zugriff
   * erneut. Eine Absage erreicht den Client also als normale 403-JSON-Antwort,
   * nicht als halboffener SSE-Stream.
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
   * 4. (Review-Fund, Critical 2 + Runde 2) `req.on('close', …)` MUSS
   *    registriert sein, BEVOR IRGENDEIN `await` in diesem Handler läuft —
   *    nicht nur vor `open()`. `'close'` feuert genau einmal auf
   *    `IncomingMessage`; passierte das während irgendeinem `await` hier
   *    (`clusters.findById` eingeschlossen — Runde 1 hatte den Listener
   *    versehentlich DAHINTER registriert, ein schmaleres, aber
   *    strukturell identisches Fenster) hätte ein erst danach registrierter
   *    Listener dieses Ereignis nie gesehen. `res.writableEnded` wird
   *    ausschliesslich durch unser EIGENES `res.end()` wahr, ein
   *    verschwundener Client setzt es nicht. Ein `follow`-Stream liefe dann
   *    bis zum Ende der Pod-Ausgabe weiter, ohne dass ihn noch jemand liest,
   *    und hielte Cluster-Verbindung, Transport-Lease und den 15s-Heartbeat
   *    für immer. `clientGone` ist deshalb der zusätzliche Flag, den
   *    `writableEnded` allein nicht liefert; `req.destroyed` ist die
   *    zusätzliche SYNCHRONE Absicherung direkt nach `findById` — Node
   *    setzt `destroyed` beim Zerstören des Streams sofort, das `'close'`-
   *    Event selbst kann noch einen Tick brauchen.
   * 5. (Review-Fund, Important 4) Der Cluster wird VOR dem ersten
   *    `setHeader` aufgelöst (`clusters.findById`) — ein unbekannter/
   *    ungültiger Cluster bekommt eine saubere JSON-Antwort (400/404) statt
   *    eines halb geöffneten SSE-Streams. Gleiches Muster wie
   *    `workspaces.controller.ts` (`execStream`) — bewusst NICHT geändert
   *    dort, siehe Runde-2-Notiz im Report: derselbe Listener-nach-await-
   *    Fehler steckt dort ausserhalb dieses Tasks.
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

    // Fix 4 (s.o.): registriert VOR JEDEM `await` in diesem Handler,
    // eingeschlossen dem `clusters.findById` gleich unten — nicht nur vor
    // `open()` (das war die Runde-1-Version dieses Fixes, die dieselbe
    // Lücke nur enger gemacht, nicht geschlossen hat). `session` ist zu
    // diesem Zeitpunkt noch undefined, falls der Client geht, während
    // `findById`/`open()` noch laufen — `session?.close()` ist dann ein
    // No-Op, deshalb die `clientGone`-Nachträge weiter unten.
    let session: Awaited<ReturnType<KubeLogsService['open']>> | undefined;
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      session?.close();
    });

    // Fix 5 (s.o.): VOR dem ersten setHeader. Wirft `clusters.findById` (400
    // ungültige Id, 404 unbekannter Cluster), ist noch keine Response-Zeile
    // geschrieben — Nests Filter liefert ein sauberes JSON, kein halb
    // geöffneter SSE-Stream.
    await this.clusters.findById(id);

    // Fix 7 (Review-Fund I2): die Audit-Zeile hängt im ÄUSSERSTEN `finally`
    // ab hier, nicht mehr im `finally` um die Leseschleife. Vorher blieben
    // zwei Pfade unprotokolliert — der Abbruch vor `open()` (gleich unten)
    // und ein gescheitertes `open()` selbst, also ausgerechnet die beiden
    // Fälle, in denen jemand später fragt, warum nichts kam. Jetzt schreibt
    // JEDER Ausstieg nach dem aufgelösten Cluster genau eine Zeile;
    // `auditError` trägt den Grund, falls es einen gab.
    let auditError: string | undefined;
    try {
      // Runde 2 (Review-Fund): der Client kann WÄHREND `findById` gegangen
      // sein. `clientGone` deckt den Fall ab, in dem `'close'` bereits
      // gefeuert hat; `req.destroyed` zusätzlich den Fall, in dem der Stream
      // schon zerstört ist, das `'close'`-Event selbst aber erst einen Tick
      // später kommt. Beides führt hierher, BEVOR auch nur ein Header steht
      // oder `open()` je aufgerufen wird — kein Transport wird erst gar nicht
      // erworben, es gibt also nichts freizugeben ausser dem, was `close()`
      // im Listener oben schon (als No-Op) versucht hat.
      if (clientGone || req.destroyed) {
        auditError = 'Client ging vor dem Öffnen des Streams';
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const send = (event: Record<string, unknown>) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Fix 6 (s.o.): dieselbe Stelle, an der der Handler die Session
      // schliesst, räumt auch den Heartbeat ab — beides im inneren `finally`.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 15000);

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
          auditError = message;
          send({ type: 'error', message });
          return;
        }

        // Der Client kann schon während open() gegangen sein (s.o., Fix 4) —
        // `session` ist jetzt zwar offen, aber niemand liest mehr. Der
        // Listener oben hat `close()` bereits versucht (war zu dem Zeitpunkt
        // noch ein No-Op über `?.`); das wird hier nachgeholt.
        if (clientGone) {
          session.close();
          auditError = 'Client ging während des Öffnens';
          return;
        }

        try {
          let stalled = false;
          for await (const line of session.lines) {
            // `close()` beendet `lines` nicht sofort (bereits gepufferte
            // Zeilen fliessen noch ab), und `res.writableEnded` wird nur durch
            // unser EIGENES `res.end()` wahr — ein verschwundener Client
            // setzt es nicht (Fix 4/Critical 2). `clientGone` ist deshalb Teil
            // der Abbruchbedingung, nicht nur `writableEnded`.
            if (clientGone || res.writableEnded) break;
            // M-17: Backpressure. Vorher wurde der Rückgabewert von write()
            // ignoriert — ein stehengebliebener (nicht getrennter) Client bei
            // `follow` liess Node unbegrenzt puffern, während der Pod mit
            // voller Geschwindigkeit weiterlieferte. Jetzt wartet die Schleife
            // auf `drain`; solange sie nicht weiterzieht, staut sich auch der
            // Log-Stream zum Cluster. Liest der Client zu lange gar nicht,
            // wird abgebrochen.
            if (!res.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`)) {
              if (!await waitForDrain(res, LOG_STREAM_DRAIN_TIMEOUT_MS)) {
                stalled = true;
                break;
              }
            }
          }
          if (stalled) {
            auditError = `Client liest nicht mehr (kein drain nach ${LOG_STREAM_DRAIN_TIMEOUT_MS / 1000} s)`;
            return;
          }
          // `lines` endet nach einem Verbindungsabbruch genauso sauber wie
          // nach einem regulären Ende (siehe JSDoc oben) — `session.error()`
          // ist die einzige Stelle, an der sich das nachträglich
          // unterscheiden lässt.
          const streamError = session.error();
          if (streamError) {
            auditError = streamError;
            send({ type: 'error', message: streamError });
          } else {
            send({ type: 'done' });
          }
        } catch (err) {
          const message = kubeApiExceptionMessage(err).slice(0, 500);
          auditError = message;
          send({ type: 'error', message });
        } finally {
          session.close();
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    } finally {
      await this.audit.record({
        clusterId: id, action: 'logs', sourceContext: this.sourceOf(req),
        userId: this.userIdOf(req), resource: 'Pod', namespace: q.namespace, name: q.pod,
        durationMs: Date.now() - started, errorMsg: auditError,
      });
    }
  }
}
