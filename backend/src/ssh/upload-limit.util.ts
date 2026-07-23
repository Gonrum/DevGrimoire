import type { Readable, Writable } from 'node:stream';

/**
 * Absolute, non-overridable ceiling for a single SFTP upload. Even a global
 * setting or a per-connection override is clamped down to this. 500 MB keeps
 * base64-decode RAM (~1.33x) and streaming memory bounded.
 */
export const SFTP_HARD_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Legacy default used when no global setting is present. */
export const SFTP_DEFAULT_UPLOAD_BYTES = 10 * 1024 * 1024;

function sanitize(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Resolve the effective per-upload byte cap.
 *   precedence: connection override > global setting > default
 *   then clamp to [1, hardMax].
 * Any invalid (0/negative/NaN/null) value at a level is skipped, falling
 * through to the next level; if all are invalid, `defaultBytes` is used.
 */
export function computeEffectiveUploadLimit(
  globalBytes: number | null,
  connectionBytes: number | null | undefined,
  opts: { defaultBytes?: number; hardMax?: number } = {},
): number {
  const defaultBytes = opts.defaultBytes ?? SFTP_DEFAULT_UPLOAD_BYTES;
  const hardMax = opts.hardMax ?? SFTP_HARD_MAX_UPLOAD_BYTES;
  const chosen =
    sanitize(connectionBytes) ?? sanitize(globalBytes) ?? defaultBytes;
  return Math.min(Math.max(1, chosen), hardMax);
}

/**
 * Pipe `source` into `writable`, counting bytes. If the running total exceeds
 * `limitBytes`, both streams are destroyed and the promise rejects with
 * `upload_too_large`. Resolves with the total bytes written once the writable
 * finishes. Any stream error rejects.
 */
export function pipeToSftpWithLimit(
  writable: Writable,
  source: Readable,
  limitBytes: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { source.destroy(); } catch { /* noop */ }
      try { writable.destroy(); } catch { /* noop */ }
      reject(err);
    };

    source.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        fail(new Error(`upload_too_large: ${total} > ${limitBytes}`));
      }
    });
    source.on('error', fail);
    writable.on('error', fail);
    writable.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });
    writable.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });

    source.pipe(writable);
  });
}
