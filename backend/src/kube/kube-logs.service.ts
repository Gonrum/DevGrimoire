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
    const finish = () => {
      if (closed) return;
      closed = true;
      try { abort?.(); } catch { /* der Abbruch darf die Freigabe nicht verhindern */ }
      release();
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
        this.logger.warn(`Log-Quelle ${namespace}/${pod}: ${errorMessage(err)}`);
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
      this.logger.warn(`Log-Stream ${namespace}/${pod}: ${errorMessage(err)}`);
      finish();
    });
    stream.on('end', finish);
    stream.on('close', finish);

    const lines = this.toLines(stream, finish);
    return { lines, close: finish };
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
