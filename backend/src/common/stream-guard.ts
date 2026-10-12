import { Readable, Transform } from 'node:stream';

/**
 * Wächter für einen durchgereichten Upstream-Body (M-52): Leerlauf-Timeout
 * und Byte-Obergrenze. Ein Upstream, der die Verbindung annimmt und dann
 * nichts mehr schickt, hielt vorher Backend- und Upstream-Socket unbegrenzt
 * offen; N gehaltene Streams = Dateideskriptoren erschöpft.
 *
 * Bewusst KEIN absolutes Gesamt-Timeout: ein grosser Download darf lange
 * dauern, solange Daten fliessen.
 */
export function guardStream(
  source: Readable,
  opts: { idleMs: number; maxBytes: number; onAbort: (reason: Error) => void },
): Readable {
  let bytes = 0;
  let timer: NodeJS.Timeout | null = null;
  const guard: Transform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        const err = new Error(`Download überschreitet ${opts.maxBytes} Bytes`);
        opts.onAbort(err);
        cb(err);
        return;
      }
      arm();
      cb(null, chunk);
    },
    flush(cb) {
      if (timer) clearTimeout(timer);
      cb();
    },
    destroy(err, cb) {
      if (timer) clearTimeout(timer);
      cb(err);
    },
  });
  function arm(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new Error(`Upstream ${opts.idleMs} ms ohne Daten`);
      opts.onAbort(err);
      guard.destroy(err);
    }, opts.idleMs);
    timer.unref();
  }
  arm();
  source.on('error', (err) => guard.destroy(err));
  return source.pipe(guard);
}
