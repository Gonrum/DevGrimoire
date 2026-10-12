/**
 * Liest den Body einer fetch-Antwort bis höchstens `maxBytes` (H-35).
 *
 * `await res.text()` materialisiert den GANZEN Body als String, bevor eine
 * Zeile Größenlogik läuft — eine 2-GB-Antwort oder ein endlos streamender
 * Endpunkt ergab `JavaScript heap out of memory`. Der AbortController der
 * Aufrufer begrenzt nur die Dauer, nicht die Menge.
 *
 * Hier wird chunkweise gelesen und abgebrochen, sobald die Grenze erreicht
 * ist; der Rest des Streams wird per `cancel()` verworfen, damit die
 * Verbindung freikommt. Es wird höchstens ein Chunk über die Grenze gelesen.
 */
export interface CappedBody {
  /** Decodierter Text der ersten `maxBytes` Bytes (UTF-8). */
  text: string;
  /** Gelesene Bytes (bei `truncated` also die Grenze, nicht die Gesamtgröße). */
  bytesRead: number;
  /** true, wenn der Body länger war als `maxBytes`. */
  truncated: boolean;
}

export async function readBodyCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (!res.body) return { text: '', bytesRead: 0, truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytesRead += Math.max(remaining, 0);
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    text += decoder.decode();
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text, bytesRead, truncated };
}

/** Verwirft einen nicht benötigten Body, damit die Verbindung freikommt. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}
