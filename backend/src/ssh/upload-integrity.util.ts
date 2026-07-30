import { createHash } from 'node:crypto';

/**
 * Integrity helpers for inline (`ssh_upload`) payloads.
 *
 * Background: `Buffer.from(str, 'base64')` is lenient. It skips characters
 * outside the alphabet, tolerates a broken length and never throws — so a
 * payload that lost or gained a single character decodes into *different but
 * plausible* bytes and the upload reports success. That failure mode is
 * unacceptable for a file transfer: the caller has no way to notice.
 *
 * These helpers turn silent corruption into a loud error.
 */

/** Line breaks / spaces, as emitted by `base64` without -w0. Tolerated. */
const BASE64_WHITESPACE = /[\r\n\t ]+/g;
/** Standard alphabet only (no URL-safe -_), padding only at the very end. */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Decode base64 while rejecting anything the lenient decoder would silently
 * swallow. Whitespace is stripped first; everything else must be canonical.
 */
export function decodeBase64Strict(input: string): Buffer {
  const compact = input.replace(BASE64_WHITESPACE, '');
  if (!BASE64_ALPHABET.test(compact)) {
    throw new Error(
      'invalid_base64: payload contains characters outside the base64 alphabet',
    );
  }
  if (compact.length % 4 !== 0) {
    throw new Error(
      `invalid_base64: length ${compact.length} is not a multiple of 4 — a character was lost or the payload is truncated`,
    );
  }
  const buf = Buffer.from(compact, 'base64');
  // Round-trip guard: catches non-canonical padding bits (e.g. "QQ==" vs
  // "QR==" both decode to 0x41) that the length check alone lets through.
  if (buf.toString('base64') !== compact) {
    throw new Error(
      'invalid_base64: payload is not canonical base64 — re-encoding the decoded bytes does not reproduce the input',
    );
  }
  return buf;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify `buf` against a caller-supplied digest. Accepts the digest in any
 * case and with surrounding whitespace. Returns the computed digest so the
 * caller can hand it back in the result.
 *
 * Throws BEFORE any remote handle is opened — a mismatch must never leave a
 * truncated or half-written file behind.
 */
export function assertSha256Matches(expected: string, buf: Buffer): string {
  const want = expected.trim().toLowerCase();
  if (!SHA256_HEX.test(want)) {
    throw new Error(
      `invalid_sha256: expected a 64-character hex digest, got ${JSON.stringify(expected).slice(0, 80)}`,
    );
  }
  const got = sha256Hex(buf);
  if (got !== want) {
    throw new Error(
      `checksum_mismatch: expected ${want}, decoded payload hashes to ${got} (${buf.length} bytes) — nothing was written, re-send this chunk`,
    );
  }
  return got;
}
