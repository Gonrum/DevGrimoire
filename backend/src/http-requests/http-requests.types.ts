// Plain TS shapes shared by the resolver, curl parser, service and DTOs.
// Kept free of Nest/Mongoose imports so the .cjs unit checks can load the
// compiled resolver/parser from dist/ without booting the app.

// Die erlaubten Werte stehen als Laufzeit-Listen hier, die Typen werden daraus
// abgeleitet. Damit kann ein Leser (curl-Parser, Service) einen fremden String
// per `find` prüfen und bekommt den verengten Typ aus der Prüfung — statt ihn
// mit `as HttpMethod` zu behaupten. Eine Ergänzung pflegt Liste und Typ in
// einem Schritt.
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const AUTH_TYPES = ['none', 'basic', 'bearer'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const BODY_MODES = ['none', 'raw', 'form-urlencoded', 'multipart'] as const;
export type BodyMode = (typeof BODY_MODES)[number];

// `value` ist optional, weil die Eingangsseite es weglassen darf: `KeyValueDto`
// /`HeaderDto` deklarieren `value?: string`, und der Resolver rechnet mit
// `kv.value ?? ''`. Vorher stand hier `value: string` — dieselbe Lücke, die den
// `as unknown as RequestDefinition`-Cast im Service nötig machte.
export interface KeyValue {
  key: string;
  value?: string;
  enabled?: boolean;
}

export interface HeaderEntry {
  name: string;
  value?: string;
  enabled?: boolean;
}

export interface RequestAuth {
  type: AuthType;
  username?: string;
  password?: string;
  token?: string;
}

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  contentType?: string;
  formFields?: KeyValue[];
}

export interface RequestDefinition {
  method: HttpMethod;
  url: string;
  queryParams?: KeyValue[];
  headers?: HeaderEntry[];
  auth?: RequestAuth;
  body?: RequestBody;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export interface ResolvedRequest extends RequestDefinition {
  unresolved: string[];
}

export interface ParsedCurlRequest {
  method: HttpMethod;
  url: string;
  queryParams: KeyValue[];
  headers: HeaderEntry[];
  auth: RequestAuth;
  body: RequestBody;
  followRedirects: boolean;
  warnings: string[];
}
