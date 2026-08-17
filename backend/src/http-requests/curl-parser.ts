import {
  ParsedCurlRequest, HttpMethod, HTTP_METHODS, KeyValue, HeaderEntry, RequestAuth, RequestBody,
} from './http-requests.types';

// --- Shell-aware tokenizer: single/double quotes, backslash escapes, \<nl> continuations. ---
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === '\\') {
      if (input[i + 1] === '\n') { i += 2; continue; }
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 3; continue; }
      if (i + 1 < n) { cur += input[i + 1]; has = true; i += 2; continue; }
      i += 1; continue;
    }
    if (c === "'") {
      has = true; i += 1;
      while (i < n && input[i] !== "'") { cur += input[i]; i += 1; }
      i += 1; continue;
    }
    if (c === '"') {
      has = true; i += 1;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n && ['"', '\\', '$', '`'].includes(input[i + 1])) {
          cur += input[i + 1]; i += 2; continue;
        }
        cur += input[i]; i += 1;
      }
      i += 1; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has) { tokens.push(cur); cur = ''; has = false; }
      i += 1; continue;
    }
    cur += c; has = true; i += 1;
  }
  if (has) tokens.push(cur);
  return tokens;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function splitQuery(url: string): { base: string; query: KeyValue[] } {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { base: url, query: [] };
  const base = url.slice(0, qIdx);
  const query: KeyValue[] = [];
  for (const pair of url.slice(qIdx + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    query.push({ key: safeDecode(rawKey), value: safeDecode(rawVal), enabled: true });
  }
  return { base, query };
}

export function parseCurl(input: string): ParsedCurlRequest {
  const warnings: string[] = [];
  let tokens = tokenize(input.trim());
  if (tokens[0] === 'curl') tokens = tokens.slice(1);

  let url = '';
  let method: HttpMethod | undefined;
  const headers: HeaderEntry[] = [];
  const dataParts: string[] = [];
  const urlencodeParts: string[] = [];
  const formFields: KeyValue[] = [];
  const auth: RequestAuth = { type: 'none' };
  let followRedirects = false;
  let getMode = false;
  let explicitContentType: string | undefined;

  const takeValue = (inlineVal: string | undefined, next: () => string | undefined): string => {
    if (inlineVal !== undefined) return inlineVal;
    const v = next();
    return v ?? '';
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length === 0) continue;

    let flag = tok;
    let inlineVal: string | undefined;

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) { flag = tok.slice(0, eq); inlineVal = tok.slice(eq + 1); }
    } else if (tok.startsWith('-') && tok.length > 2) {
      // glued short flag, e.g. -XPOST, -H'...'
      flag = tok.slice(0, 2);
      inlineVal = tok.slice(2);
    }

    const next = () => tokens[++i];

    switch (flag) {
      case '-X': case '--request': {
        // `find` statt `as HttpMethod`: ein `-X FOO` behauptete vorher eine
        // Methode, die es nicht gibt, und fiel erst weiter hinten auf — beim
        // Import an der Enum-Prüfung des Schemas, beim Senden am fetch().
        // Jetzt greift die normale Inferenz (POST bei Body, sonst GET) und die
        // verworfene Methode steht in den Warnungen, die der Import ausgibt.
        const requested = takeValue(inlineVal, next).toUpperCase();
        const known = HTTP_METHODS.find((candidate) => candidate === requested);
        if (known) method = known;
        else warnings.push(`Unbekannte HTTP-Methode ignoriert: ${requested}`);
        break;
      }
      case '-H': case '--header': {
        const raw = takeValue(inlineVal, next);
        const idx = raw.indexOf(':');
        if (idx !== -1) {
          const name = raw.slice(0, idx).trim();
          const value = raw.slice(idx + 1).trim();
          if (name.toLowerCase() === 'content-type') explicitContentType = value;
          headers.push({ name, value, enabled: true });
        }
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': {
        let v = takeValue(inlineVal, next);
        if (v.startsWith('@')) { warnings.push(`Datei-Referenz ${v} kann nicht importiert werden`); v = v.slice(1); }
        dataParts.push(v);
        break;
      }
      case '--data-urlencode': {
        const v = takeValue(inlineVal, next);
        const eq = v.indexOf('=');
        if (eq !== -1) urlencodeParts.push(`${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`);
        else urlencodeParts.push(encodeURIComponent(v));
        break;
      }
      case '-F': case '--form': {
        const v = takeValue(inlineVal, next);
        const eq = v.indexOf('=');
        const key = eq === -1 ? v : v.slice(0, eq);
        let value = eq === -1 ? '' : v.slice(eq + 1);
        if (value.startsWith('@') || value.startsWith('<')) { warnings.push(`Datei-Feld ${key} als Text importiert`); value = value.slice(1); }
        formFields.push({ key, value, enabled: true });
        break;
      }
      case '-u': case '--user': {
        const v = takeValue(inlineVal, next);
        const idx = v.indexOf(':');
        auth.type = 'basic';
        auth.username = idx === -1 ? v : v.slice(0, idx);
        auth.password = idx === -1 ? '' : v.slice(idx + 1);
        break;
      }
      case '-b': case '--cookie':
        headers.push({ name: 'Cookie', value: takeValue(inlineVal, next), enabled: true });
        break;
      case '-A': case '--user-agent':
        headers.push({ name: 'User-Agent', value: takeValue(inlineVal, next), enabled: true });
        break;
      case '-e': case '--referer':
        headers.push({ name: 'Referer', value: takeValue(inlineVal, next), enabled: true });
        break;
      case '--url':
        url = takeValue(inlineVal, next);
        break;
      case '-L': case '--location':
        followRedirects = true;
        break;
      case '-G': case '--get':
        getMode = true;
        break;
      case '-I': case '--head':
        method = 'HEAD';
        break;
      case '--compressed':
        break; // fetch handles decompression transparently
      default:
        if (!tok.startsWith('-') && !url) url = tok;
        else if (tok.startsWith('-')) warnings.push(`Unbekanntes Flag ignoriert: ${flag}`);
        break;
    }
  }

  if (!url) throw new Error('No URL found in curl command');

  const { base, query } = splitQuery(url);
  const queryParams = query;

  const joinedData = [...dataParts, ...urlencodeParts].join('&');

  // -G: data becomes query params, GET method.
  if (getMode && joinedData) {
    for (const pair of joinedData.split('&')) {
      const eq = pair.indexOf('=');
      queryParams.push({ key: safeDecode(eq === -1 ? pair : pair.slice(0, eq)), value: safeDecode(eq === -1 ? '' : pair.slice(eq + 1)), enabled: true });
    }
  }

  let body: RequestBody = { mode: 'none' };
  if (!getMode && formFields.length > 0) {
    body = { mode: 'multipart', formFields };
  } else if (!getMode && joinedData) {
    body = { mode: 'raw', raw: joinedData, contentType: explicitContentType || 'application/x-www-form-urlencoded' };
  }

  const hasBody = body.mode !== 'none';
  const resolvedMethod: HttpMethod = method || (hasBody ? 'POST' : 'GET');

  return {
    method: getMode ? 'GET' : resolvedMethod,
    url: base,
    queryParams,
    headers,
    auth,
    body,
    followRedirects,
    warnings,
  };
}
