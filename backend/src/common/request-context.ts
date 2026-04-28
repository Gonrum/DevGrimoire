import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiKey } from '../api-keys/schemas/api-key.schema';

export interface RequestUser {
  userId: string;
  username: string;
  role: string;
}

export interface RequestState {
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
