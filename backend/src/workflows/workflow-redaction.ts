/**
 * Centralized redaction for workflow runs.
 *
 * Used everywhere we persist or expose data that may carry secrets (node-run
 * outputs, logs, errors, inspect responses). Combines three layers:
 *
 *  - Known-value tokens: explicit secret strings registered by executors after
 *    resolving a SecretRef. Replaced verbatim with [SECRET].
 *  - Sensitive-key masking: object keys whose name looks like a credential
 *    (authorization, token, apiKey, etc.) get their value replaced with [MASKED].
 *  - Pattern masking: strings get bearer-token and `key=value`-style credentials
 *    rewritten.
 *
 * Persisted shape is always `{ value, truncated, maskedPaths }` so the runner
 * never stores raw mutations alongside untrusted input.
 */

const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|cookie)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KV_RE = /(api[-_]?key|secret|token|password|passwd)\s*[:=]\s*[^\s,;]+/gi;

export interface RedactOptions {
  /** Extra literal strings (resolved secret values) to scrub everywhere. */
  knownTokens?: readonly string[];
  /** Max characters in the JSON-serialized result (default 4096). */
  maxChars?: number;
  /** Per-string cap (default 500). Longer strings get a "…" tail. */
  maxStringLength?: number;
  /** Object depth before bailing out (default 6). */
  maxDepth?: number;
}

export interface RedactedValue<T = unknown> {
  value: T;
  truncated: boolean;
  maskedPaths: string[];
}

/**
 * Returns the value with secrets scrubbed. Always safe to persist — never
 * leaks known tokens, never bearer headers, never keys named like credentials.
 *
 * For primitives, the returned `value` is a primitive. For objects/arrays,
 * a defensive copy is made (no mutation of the caller's input).
 */
export function redact<T = unknown>(
  input: T,
  options: RedactOptions = {},
): RedactedValue<T> {
  const knownTokens = (options.knownTokens ?? []).filter((s) => s && s.length >= 4);
  const maxChars = options.maxChars ?? 4096;
  const maxStringLength = options.maxStringLength ?? 500;
  const maxDepth = options.maxDepth ?? 6;
  const maskedPaths: string[] = [];
  const seen = new WeakSet<object>();
  let truncated = false;

  const redactString = (s: string, path: string): string => {
    let out = s;
    for (const token of knownTokens) {
      if (out.includes(token)) {
        out = out.split(token).join('[SECRET]');
        maskedPaths.push(path || '$');
      }
    }
    const before = out;
    out = out.replace(BEARER_RE, 'Bearer [MASKED]').replace(KV_RE, '$1=[MASKED]');
    if (out !== before) maskedPaths.push(path || '$');
    if (out.length > maxStringLength) {
      truncated = true;
      return `${out.slice(0, maxStringLength)}…`;
    }
    return out;
  };

  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === 'string') return redactString(current, path);
    if (typeof current !== 'object') return current;
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    if (depth >= maxDepth) {
      truncated = true;
      return '[Truncated: max depth]';
    }
    if (Array.isArray(current)) {
      if (current.length > 25) truncated = true;
      return current
        .slice(0, 25)
        .map((item, idx) => visit(item, `${path}[${idx}]`, depth + 1));
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > 50) truncated = true;
    for (const [key, child] of entries.slice(0, 50)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[MASKED]';
        maskedPaths.push(childPath);
        continue;
      }
      out[key] = visit(child, childPath, depth + 1);
    }
    return out;
  };

  const safe = visit(input, '', 0);
  const json = typeof safe === 'object' && safe !== null ? JSON.stringify(safe) : undefined;
  if (json && json.length > maxChars) {
    truncated = true;
    return {
      value: `${json.slice(0, maxChars)}…` as unknown as T,
      truncated,
      maskedPaths,
    };
  }
  return { value: safe as T, truncated, maskedPaths };
}

/**
 * Convenience: redact and return only the cleaned value (no envelope).
 * Use this when persisting back into a structured field that is itself an
 * object/array — the caller does not need truncated/maskedPaths metadata.
 */
export function redactValue<T = unknown>(input: T, options: RedactOptions = {}): T {
  return redact(input, options).value;
}

/**
 * Redact a per-line log array. Each entry is treated as its own object and
 * scrubbed independently; long strings are capped to LOG_LINE_CAP after
 * redaction (per docs/workflow-security.md "Max persisted log line length").
 */
export function redactLogs(
  logs: Array<Record<string, unknown>>,
  knownTokens: readonly string[] = [],
): Array<Record<string, unknown>> {
  return logs.map(
    (entry) =>
      redact(entry, {
        knownTokens,
        maxStringLength: 1024,
        maxDepth: 4,
      }).value as Record<string, unknown>,
  );
}
