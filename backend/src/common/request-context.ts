import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestUser {
  userId: string;
  username: string;
  role: string;
}

const asyncLocalStorage = new AsyncLocalStorage<{ user?: RequestUser }>();

export const RequestContext = {
  run<T>(user: RequestUser | undefined, fn: () => T): T {
    return asyncLocalStorage.run({ user }, fn);
  },
  getUser(): RequestUser | undefined {
    return asyncLocalStorage.getStore()?.user;
  },
};
