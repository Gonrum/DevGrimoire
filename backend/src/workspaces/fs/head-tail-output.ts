/** Bytes kept from the start of a stream before the rolling tail takes over. */
export const EXEC_HEAD_BYTES = 8 * 1024;
/** Room kept free for the omission marker (its text is far shorter). */
const MARKER_RESERVE = 64;

export function omittedMarker(bytes: number): string {
  return `\n… ${bytes} bytes omitted …\n`;
}

/**
 * Bounded collector for one output stream: the first bytes (head, at most
 * `EXEC_HEAD_BYTES`) plus a rolling tail. `text()` never exceeds `maxBytes`
 * UTF-8 bytes; when bytes were dropped it is `head + marker + tail`. Memory
 * stays bounded however much is pushed, so a command never has to be stopped
 * because of its output.
 */
export class HeadTailOutput {
  private readonly headMax: number;
  private readonly tailMax: number;
  private readonly head: Buffer[] = [];
  private headLen = 0;
  private readonly tail: Buffer[] = [];
  private tailLen = 0;
  private total = 0;

  constructor(maxBytes: number) {
    const max = Math.max(0, Math.floor(maxBytes));
    if (max <= 2 * MARKER_RESERVE) {
      this.headMax = max;
      this.tailMax = 0;
    } else {
      this.headMax = Math.min(EXEC_HEAD_BYTES, Math.floor((max - MARKER_RESERVE) / 2));
      this.tailMax = max - MARKER_RESERVE - this.headMax;
    }
  }

  push(chunk: Buffer | string): void {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.total += buf.length;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, buf.length);
      this.head.push(buf.subarray(0, take));
      this.headLen += take;
      buf = buf.subarray(take);
    }
    if (buf.length === 0 || this.tailMax === 0) return;
    if (buf.length >= this.tailMax) {
      this.tail.length = 0;
      this.tail.push(buf.subarray(buf.length - this.tailMax));
      this.tailLen = this.tailMax;
      return;
    }
    this.tail.push(buf);
    this.tailLen += buf.length;
    while (this.tailLen > this.tailMax) {
      const first = this.tail[0];
      const excess = this.tailLen - this.tailMax;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLen -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailLen -= excess;
      }
    }
  }

  /** Bytes pushed but not kept. */
  get omitted(): number {
    return this.total - this.headLen - this.tailLen;
  }

  get truncated(): boolean {
    return this.omitted > 0;
  }

  text(): string {
    const head = Buffer.concat(this.head, this.headLen);
    const tail = Buffer.concat(this.tail, this.tailLen);
    if (!this.truncated) return Buffer.concat([head, tail]).toString('utf8');
    // Cut on character boundaries: drop a partial sequence at the head's end
    // and continuation bytes at the tail's start; they count as omitted.
    let headEnd = head.length;
    let back = headEnd;
    while (back > 0 && (head[back - 1] & 0xc0) === 0x80) back -= 1;
    if (back > 0) {
      const lead = head[back - 1];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (headEnd - (back - 1) < need) headEnd = back - 1;
    }
    // Too small for a marker: the head alone.
    if (this.tailMax === 0) return head.subarray(0, headEnd).toString('utf8');
    let tailStart = 0;
    while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart += 1;
    const omitted = this.total - headEnd - (tail.length - tailStart);
    return head.subarray(0, headEnd).toString('utf8') + omittedMarker(omitted)
      + tail.subarray(tailStart).toString('utf8');
  }
}

/** `text` cut to head + marker + tail within `maxBytes`; unchanged when it fits. */
export function headTailText(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  const out = new HeadTailOutput(maxBytes);
  out.push(text);
  return { text: out.text(), cut: true };
}
