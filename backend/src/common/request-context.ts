import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiKey } from '../api-keys/schemas/api-key.schema';
import type { ActorScope, ScopeMode } from './permissions';

export interface RequestUser extends ActorScope {
  userId: string;
  username: string;
  role: string;
  apiKeyId?: string;
}

export interface RequestState {
  user?: RequestUser;
  apiKey?: ApiKey;
}

/**
 * Der Express-Request, nachdem `JwtAuthGuard` einen Actor angehängt hat.
 *
 * Kanonische Fassung — vorher gab es fünf unabhängige Deklarationen dieser Form
 * im Projekt, davon drei in Controllern nur als `user?: { userId?: string }`.
 * Das war verlustbehaftet: der Guard hängt zusätzlich `role`, `permissions` und
 * beide Scope-Achsen an, die Controller konnten die Felder für
 * `actorHasPermission`/`actorCanAccessProject` also gar nicht sehen.
 *
 * `user` ist absichtlich derselbe `RequestUser`, den `RequestContext` und die
 * `ActorScope`-Helfer nachgelagert konsumieren.
 */
export interface AuthRequest {
  user?: RequestUser;
  apiKey?: ApiKey;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestState>();

export const RequestContext = {
  run<T>(user: RequestUser | undefined, apiKey: ApiKey | undefined, fn: () => T): T {
    return asyncLocalStorage.run({ user, apiKey }, fn);
  },
  getUser(): RequestUser | undefined {
    return asyncLocalStorage.getStore()?.user;
  },
  getApiKey(): ApiKey | undefined {
    return asyncLocalStorage.getStore()?.apiKey;
  },
};

export type { ActorScope, ScopeMode };
