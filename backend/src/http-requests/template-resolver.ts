import { RequestDefinition, ResolvedRequest, KeyValue, HeaderEntry } from './http-requests.types';

export interface ResolutionInputs {
  variables: { key: string; value: string }[];
  globalSecrets: { key: string; value: string }[];
  envSecrets: { key: string; value: string }[];
}

export interface ResolutionContext {
  values: Map<string, string>;
  secretValues: Set<string>;
}

// Precedence (later wins): global secret < variable < env-scoped secret.
// Every secret VALUE (global + env) is tracked for masking regardless of
// whether a same-named variable shadowed it in `values`.
export function buildResolutionContext(inputs: ResolutionInputs): ResolutionContext {
  const values = new Map<string, string>();
  const secretValues = new Set<string>();
  for (const s of inputs.globalSecrets ?? []) { values.set(s.key, s.value); if (s.value) secretValues.add(s.value); }
  for (const v of inputs.variables ?? []) { values.set(v.key, v.value); }
  for (const s of inputs.envSecrets ?? []) { values.set(s.key, s.value); if (s.value) secretValues.add(s.value); }
  return { values, secretValues };
}

const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function resolveTemplates(input: string, ctx: ResolutionContext, unresolved: Set<string>): string {
  if (!input) return input;
  return input.replace(TEMPLATE_RE, (match, key: string) => {
    if (ctx.values.has(key)) return ctx.values.get(key)!;
    unresolved.add(key);
    return match;
  });
}

function resolveKeyValues(items: KeyValue[] | undefined, ctx: ResolutionContext, unresolved: Set<string>): KeyValue[] {
  return (items ?? []).map((kv) => ({
    key: resolveTemplates(kv.key, ctx, unresolved),
    value: resolveTemplates(kv.value ?? '', ctx, unresolved),
    enabled: kv.enabled !== false,
  }));
}

function resolveHeaders(items: HeaderEntry[] | undefined, ctx: ResolutionContext, unresolved: Set<string>): HeaderEntry[] {
  return (items ?? []).map((h) => ({
    name: resolveTemplates(h.name, ctx, unresolved),
    value: resolveTemplates(h.value ?? '', ctx, unresolved),
    enabled: h.enabled !== false,
  }));
}

export function resolveRequest(def: RequestDefinition, ctx: ResolutionContext): ResolvedRequest {
  const unresolvedSet = new Set<string>();
  const auth = def.auth
    ? {
        type: def.auth.type,
        username: def.auth.username !== undefined ? resolveTemplates(def.auth.username, ctx, unresolvedSet) : undefined,
        password: def.auth.password !== undefined ? resolveTemplates(def.auth.password, ctx, unresolvedSet) : undefined,
        token: def.auth.token !== undefined ? resolveTemplates(def.auth.token, ctx, unresolvedSet) : undefined,
      }
    : undefined;
  const body = def.body
    ? {
        mode: def.body.mode,
        raw: def.body.raw !== undefined ? resolveTemplates(def.body.raw, ctx, unresolvedSet) : undefined,
        contentType: def.body.contentType,
        formFields: def.body.formFields ? resolveKeyValues(def.body.formFields, ctx, unresolvedSet) : undefined,
      }
    : undefined;
  return {
    method: def.method,
    url: resolveTemplates(def.url, ctx, unresolvedSet),
    queryParams: resolveKeyValues(def.queryParams, ctx, unresolvedSet),
    headers: resolveHeaders(def.headers, ctx, unresolvedSet),
    auth,
    body,
    timeoutMs: def.timeoutMs,
    followRedirects: def.followRedirects,
    unresolved: [...unresolvedSet],
  };
}

// Redact every occurrence of each secret value. split/join avoids regex
// injection; longest-first prevents a short secret that is a substring of a
// longer one from leaving a partial leak.
export function maskSecrets(text: string, secretValues: Iterable<string>): string {
  if (!text) return text;
  const values = [...secretValues].filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('***');
  return out;
}
