import { createContext, useContext } from 'react';

/*
 * Kontext + Hook. Der Provider liegt in `AuthProvider.tsx`.
 *
 * Warum getrennt: `react-refresh/only-export-components` verlangt, dass eine
 * Datei entweder Komponenten oder anderes exportiert, nicht beides. Vorher
 * standen `AuthProvider` (Komponente) und `useAuth` (Hook) zusammen, wodurch
 * Fast Refresh für den Provider — und damit für den ganzen Baum darunter — nicht
 * funktionierte. Die Auth-Logik selbst ist unverändert mitgewandert.
 */

export interface UserInfo {
  userId: string;
  username: string;
  role: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  authEnabled: boolean | null;
  loading: boolean;
  user: UserInfo | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => string | null;
  /**
   * Neues Access-Token nach einem Refresh übernehmen.
   *
   * Ohne diesen Weg holte der Refresh-Handler in `App.tsx` zwar ein neues
   * Token-Paar, legte aber nur das Refresh-Token ab — `accessTokenRef` im
   * Provider blieb auf dem abgelaufenen Wert stehen. Der 401-Retry in
   * `api/client.ts` fragt `getAccessToken()` erneut ab und wiederholte damit
   * mit genau demselben toten Token: der Refresh meldete Erfolg, die
   * Anfrage scheiterte trotzdem.
   */
  applyAccessToken: (accessToken: string) => void;
}

export const AuthContext = createContext<AuthState>(null!);

export function useAuth() {
  return useContext(AuthContext);
}
