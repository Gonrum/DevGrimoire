// Plain TS shapes shared by the resolver, curl parser, service and DTOs.
// Kept free of Nest/Mongoose imports so the .cjs unit checks can load the
// compiled resolver/parser from dist/ without booting the app.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type AuthType = 'none' | 'basic' | 'bearer';
export type BodyMode = 'none' | 'raw' | 'form-urlencoded' | 'multipart';

export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface HeaderEntry {
  name: string;
  value: string;
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
