import { Injectable, Logger, Optional } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { KubeConfig, Log } from '@kubernetes/client-node';
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
    stream: NodeJS.WritableStream, options?: Record<string, unknown>,
  ): Promise<{ abort: () => void }>;
};

const DEFAULT_LOG_FACTORY: KubeLogFactory = (kc) => new Log(kc);
const LINE_MAX = 8192;
const TAIL_DEFAULT = 200;

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

    // Ein Log-Stream lebt Minuten bis Stunden. Freigabe genau einmal, egal
    // ob der Stream normal endet, der Client geht oder der Aufbau scheitert.
    let closed = false;
    let abort: (() => void) | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      try { abort?.(); } catch { /* der Abbruch darf die Freigabe nicht verhindern */ }
      release();
    };

    const stream = new PassThrough();
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
   * Container, der ohne Zeilenumbruch protokolliert, soll nicht den Speicher
   * des Backends füllen.
   */
  private async *toLines(stream: PassThrough, finish: () => void): AsyncGenerator<string> {
    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += typeof chunk === 'string' ? chunk : String(chunk);
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
      if (buffer.length > 0) yield buffer.slice(0, LINE_MAX);
    } finally {
      finish();
    }
  }
}
