import { Injectable, Logger, Optional } from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { KubeConfig, Log, LogOptions } from '@kubernetes/client-node';
import { KubeClustersService } from './kube-clusters.service';
import { KubeClientService } from './kube-client.service';
import { errorMessage } from '../common/narrow';

export interface KubeLogOptions {
  container?: string;
  tailLines?: number;
  previous?: boolean;
  follow?: boolean;
  sinceSeconds?: number;
}

export interface KubeLogSession {
  /** Zeilenweise Ausgabe. Endet, wenn der Stream endet oder abgebrochen wird. */
  lines: AsyncIterable<string>;
  /** Bricht ab und gibt den Transport frei. Mehrfach aufrufbar. */
  close: () => void;
  /**
   * Meldungstext, falls der Stream durch einen Verbindungsfehler beendet
   * wurde, statt regulär oder durch einen expliziten `close()`.
   *
   * Grund für dieses Feld statt eines geworfenen Fehlers: ein Quell-Fehler,
   * der über den `'pipe'`-Listener (siehe unten) abgefangen wird, endet
   * `stream` bewusst über `stream.end()`, nicht `.destroy()` — `lines`
   * bekommt also ein reguläres `'end'`, keinen Reject. Ohne dieses Feld ist
   * ein abgebrochener Follow-Stream vom Konsumenten aus nicht von einem
   * Stream zu unterscheiden, der einfach zu Ende ist. Erst NACH dem
   * vollständigen Durchlauf von `lines` aussagekräftig — undefined vorher
   * heisst nur "noch kein Fehler gesehen", nicht "wird keinen geben".
   */
  error: () => string | undefined;
}

/** Injizierbar, damit der Check ohne Cluster auskommt (Muster: SshClientFactory). */
export type KubeLogFactory = (kc: KubeConfig) => {
  log(
    namespace: string, pod: string, container: string,
    stream: NodeJS.WritableStream, options?: LogOptions,
  ): Promise<{ abort: () => void }>;
};

const DEFAULT_LOG_FACTORY: KubeLogFactory = (kc) => new Log(kc);
const LINE_MAX = 8192;
const TAIL_DEFAULT = 200;

/**
 * Chunks aus einem Node-Stream sind praktisch immer `Buffer` (auf `stream`
 * wird nie `setEncoding()` gesetzt); der String-Zweig deckt nur ab, dass
 * eine Test-Attrappe direkt einen String schreibt (PassThrough würde ihn
 * intern ohnehin zu Buffer wandeln, bevor er die Leseseite erreicht).
 *
 * `StringDecoder` statt naiver Chunk-für-Chunk-Dekodierung: Kubernetes
 * liefert Bytes, keine Zeilen, und ein mehrbytiges UTF-8-Zeichen kann genau
 * an einer Chunk-Grenze auseinanderreißen. `String(chunk)` je Chunk würde
 * jede Hälfte unabhängig dekodieren und beide durch U+FFFD ersetzen —
 * `StringDecoder` hält den unvollständigen Rest zurück, bis der nächste
 * Chunk ihn vervollständigt.
 */
function decodeChunk(decoder: StringDecoder, chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
  if (typeof chunk === 'string') return decoder.write(chunk);
  return decoder.write(Buffer.from(String(chunk), 'utf8'));
}

@Injectable()
export class KubeLogsService {
  private readonly logger = new Logger(KubeLogsService.name);

  constructor(
    private readonly clusters: KubeClustersService,
    private readonly client: KubeClientService,
    // `KubeLogFactory` ist ein Funktionstyp und löst zur Laufzeit auf
    // `Function` auf (kein Klassen-Token) — ohne @Optional() wirft Nest
    // beim Bootstrap eine UnknownDependenciesException, sobald der Service
    // registriert ist (empirisch geprüft). Gleiches Muster wie
    // SshClientFactory in ssh-session.service.ts / ssh-test.service.ts.
    @Optional()
    private readonly logFactory: KubeLogFactory = DEFAULT_LOG_FACTORY,
  ) {}

  async open(
    clusterId: string,
    namespace: string,
    pod: string,
    opts: KubeLogOptions,
  ): Promise<KubeLogSession> {
    const cluster = await this.clusters.findById(clusterId);
    const { kc, release } = await this.client.buildConfig(cluster);

    const stream = new PassThrough();

    // Ein Log-Stream lebt Minuten bis Stunden. Freigabe genau einmal, egal
    // ob der Stream normal endet, der Client geht oder der Aufbau scheitert.
    // `stream.end()` NACH `release()`: ohne das bleibt der `for await` in
    // toLines() auf einem Read hängen, wenn die interne pipe() dem Ziel nach
    // einem Abbruch nie ein sauberes 'end' liefert — close() auf einem
    // laufenden follow-Stream ließ `lines` sonst nie enden, und
    // `try { for await (…) } finally { session.close() }` (das einzig
    // korrekte Konsumenten-Idiom, das Tasks 5/6 brauchen) erreichte sein
    // `finally` nie. Bewusst `end()`, NICHT `destroy()`: destroy() lässt
    // einen gerade aktiven `for await`-Konsumenten mit
    // ERR_STREAM_PREMATURE_CLOSE fehlschlagen (Node behandelt "zerstört,
    // bevor 'end' kam" als Fehler) — das wäre eine unhandled rejection beim
    // Aufrufer für einen absichtlichen Abbruch. `end()` beendet nur die
    // Schreibseite; PassThrough liefert bereits gepufferte Daten noch aus
    // und emittiert danach ein reguläres 'end', mit dem `toLines()` normal
    // fertig wird. `stream` hält selbst kein OS-Handle (das echte
    // HTTP/TCP-Ende hängt an `abort()`/`release()`), ein hartes `destroy()`
    // bringt hier keinen zusätzlichen Nutzen — nur das Risiko oben.
    let closed = false;
    let abort: (() => void) | undefined;
    // Task 5 (K2): einzige Stelle, an der ein Verbindungsfehler festgehalten
    // wird, bevor `finish()` den Stream sauber über `end()` schliesst — ohne
    // das liest die SSE-Schicht einen abgebrochenen Follow-Stream als
    // vollständiges Ende ("done") statt als Fehler. Wird NUR von den beiden
    // 'error'-Listenern unten gesetzt (ein selbst ausgelöstes close()/abort()
    // setzt es nicht), s. `KubeLogSession.error` oben.
    let lastError: string | undefined;
    // Jeder der drei Schritte ist gewacht, und zwar aus DEMSELBEN Grund:
    // `finish` hängt an 'end'/'close'/'error'-Listenern, und ein Wurf in
    // einem EventEmitter-Listener ist in diesem Backend eine uncaught
    // exception (kein `process.on('uncaughtException')`) — die Fehlerklasse,
    // die in dieser Phase schon zwei Prozessabstürze verursacht hat.
    //
    // `release()` war bis zum Review-Fund A1 als einziger Schritt ungewacht,
    // obwohl der Refcount aus K1 dahinter SSH-Tunnel und TCP-Listener
    // abräumt. Ein Wurf dort liess ausserdem `closed = true` zurück, OHNE
    // den Stream je zu beenden: `lines` endet dann nie, das `for await` der
    // SSE-Schicht kehrt nie zurück, ihr äusseres `finally` läuft nie —
    // Heartbeat für immer, Transport-Lease gehalten. Genau der Zustand, den
    // `finish()` verhindern soll.
    const finish = () => {
      if (closed) return;
      closed = true;
      try { abort?.(); } catch { /* der Abbruch darf die Freigabe nicht verhindern */ }
      try {
        release();
      } catch (err) {
        this.logger.warn(`Transport-Freigabe ${namespace}/${pod}: ${errorMessage(err)}`);
      }
      // NACH der Freigabe und ausserhalb ihres Wurfs: ohne das beendete
      // `lines` nie (siehe oben).
      stream.end();
    };

    // `Log.log()` verbindet die HTTP-Antwort intern per
    // `nodeStream.pipe(stream)` (log.js) — Node emittiert dabei 'pipe' AUF
    // DEM ZIEL mit der Quelle als Argument, bevor Daten fließen.
    // `Readable.prototype.pipe` hängt an der Quelle selbst NIE einen
    // 'error'-Listener ein. Unser eigenes abort() lässt die Quelle
    // (asynchron, über den AbortSignal-Pfad in undici) mit einem
    // AbortError enden — ohne diesen Hook ist das eine uncaught exception,
    // die in diesem Backend nirgends abgefangen wird (kein
    // process.on('uncaughtException'), siehe ssh-session.service.ts zur
    // selben Abwesenheit). Muss VOR dem log()-Aufruf registriert sein, weil
    // pipe() synchron innerhalb dessen läuft.
    stream.on('pipe', (src: Readable) => {
      src.on('error', (err) => {
        // `closed` bereits wahr: die Quelle endet genau WEIL wir selbst
        // abort()/end() ausgelöst haben (oder ein knapp gleichzeitiger
        // "write after end" unten) — erwartete Folge des eigenen Abbruchs,
        // kein neuer Befund. Der Listener bleibt trotzdem bestehen, weil
        // allein seine Anwesenheit die uncaught exception verhindert.
        if (closed) return;
        lastError = errorMessage(err);
        this.logger.warn(`Log-Quelle ${namespace}/${pod}: ${lastError}`);
        finish();
      });
    });

    try {
      const controller = await this.logFactory(kc).log(
        namespace, pod, opts.container ?? '', stream,
        {
          follow: opts.follow ?? false,
          tailLines: opts.tailLines ?? TAIL_DEFAULT,
          previous: opts.previous ?? false,
          ...(opts.sinceSeconds ? { sinceSeconds: opts.sinceSeconds } : {}),
          timestamps: false,
        },
      );
      abort = () => controller.abort();
    } catch (err) {
      finish();
      throw err;
    }

    stream.on('error', (err) => {
      // Gleicher Grund wie oben beim Quell-Listener: nach dem eigenen
      // close()/end() kann die noch laufende pipe() ein letztes,
      // bereits unterwegs gewesenes Stück in den bereits beendeten
      // `stream` schreiben wollen ("write after end") — erwartet, kein
      // eigenständiger Fehler.
      if (closed) return;
      lastError = errorMessage(err);
      this.logger.warn(`Log-Stream ${namespace}/${pod}: ${lastError}`);
      finish();
    });
    stream.on('end', finish);
    stream.on('close', finish);

    const lines = this.toLines(stream, finish);
    return { lines, close: finish, error: () => lastError };
  }

  /**
   * Zerlegt den Byte-Strom in Zeilen. Überlange Zeilen werden gekappt: ein
   * Container, der ohne Zeilenumbruch protokolliert, soll nicht den
   * Speicher des Backends füllen.
   */
  private async *toLines(stream: PassThrough, finish: () => void): AsyncGenerator<string> {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += decodeChunk(decoder, chunk);
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          yield buffer.slice(0, index).slice(0, LINE_MAX);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
        if (buffer.length > LINE_MAX) {
          yield buffer.slice(0, LINE_MAX);
          buffer = '';
        }
      }
      buffer += decoder.end();
      if (buffer.length > 0) yield buffer.slice(0, LINE_MAX);
    } finally {
      finish();
    }
  }
}
