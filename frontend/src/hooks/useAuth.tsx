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
}

export const AuthContext = createContext<AuthState>(null!);

export function useAuth() {
  return useContext(AuthContext);
}
