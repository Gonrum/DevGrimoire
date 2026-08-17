import { useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import i18n from '../i18n';
import { parseJsonResponse, readErrorMessageFromText } from '../api/http-boundary';
import { AuthContext, type UserInfo } from './useAuth';

/*
 * Der Auth-Provider: Token-Verwaltung, Bootstrap über `/api/auth/status` und der
 * Refresh-Pfad.
 *
 * Diese Datei wurde aus `useAuth.tsx` herausgelöst (siehe Begründung dort).
 * Inhaltlich ist nichts umgestellt: gleiche Bedingungen, gleiche Reihenfolge,
 * gleiche Requests. Geändert sind nur die Typen an den JSON-Grenzen und die
 * Indirektion über `refreshTokensRef` (siehe `scheduleRefresh`).
 */

const REFRESH_TOKEN_KEY = 'devgrimoire_refresh_token';

/** Die Felder des Access-Tokens, die hier gelesen werden. */
interface JwtPayload {
  sub?: string;
  username?: string;
  role?: string;
  exp?: number;
}

/**
 * JWT-Payload dekodieren.
 *
 * Vorher war der Rückgabetyp `any`, und dieses `any` floss von hier in
 * `setUser()` und in die Ablaufberechnung. Jetzt wird jedes Feld einzeln geprüft:
 * `in` plus `typeof` verengt `unknown` ohne Behauptung, statt die Form des
 * Payloads zu unterstellen.
 *
 * `null` bedeutet wie vorher „nicht dekodierbar". Ein Payload, der kein Objekt
 * ist (z.B. `atob` liefert `"5"`), führte vorher zu `setUser({userId: undefined,
 * …})` — jetzt zu `null` und damit zum selben Ergebnis wie ein Parse-Fehler.
 */
function parseJwtPayload(token: string): JwtPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const payload: JwtPayload = {};
  if ('sub' in raw && typeof raw.sub === 'string') payload.sub = raw.sub;
  if ('username' in raw && typeof raw.username === 'string') payload.username = raw.username;
  if ('role' in raw && typeof raw.role === 'string') payload.role = raw.role;
  if ('exp' in raw && typeof raw.exp === 'number') payload.exp = raw.exp;
  return payload;
}

/** Antwort von `POST /api/auth/login` und `POST /api/auth/refresh`. */
interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Antwort von `GET /api/auth/status`. */
interface AuthStatus {
  enabled: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<UserInfo | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setTokenAndUser = (accessToken: string) => {
    accessTokenRef.current = accessToken;
    const payload = parseJwtPayload(accessToken);
    if (payload) {
      /*
       * `?? ''` ist der Punkt, an dem der alte `any`-Fluss sichtbar wird:
       * `UserInfo` verspricht drei Strings, der Payload garantiert sie nicht.
       * Vorher landete bei einem Token ohne `sub` schlicht `undefined` im
       * State — mit dem Typ `string` daneben. Der Leerstring verhält sich für
       * alle Leser gleich (`user.role === 'admin'` bleibt falsch, ein
       * gerenderter Leerstring bleibt unsichtbar), lügt aber nicht.
       */
      setUser({
        userId: payload.sub ?? '',
        username: payload.username ?? '',
        role: payload.role ?? '',
      });
    }
  };

  /*
   * `scheduleRefresh` und `refreshTokens` rufen sich gegenseitig: der Timer
   * startet den Refresh, der Refresh plant den nächsten Timer. Als direkte
   * Referenz war das zweierlei Verstoss — `react-hooks/immutability`
   * (`refreshTokens` vor seiner Deklaration gelesen) und ein Dep-Zyklus, der
   * `exhaustive-deps` nicht erfüllbar macht: jede der beiden Dep-Listen
   * bräuchte die andere Funktion, und beide würden sich pro Render neu bilden.
   *
   * Das Ref bricht den Zyklus, ohne den Ablauf anzufassen: derselbe Aufruf, zum
   * selben Zeitpunkt, mit demselben `.catch()`. Geschrieben wird im Effekt, nicht
   * im Render (`react-hooks/refs`) — der Timer feuert frühestens 5s später, das
   * Ref ist dann längst gesetzt.
   */
  const refreshTokensRef = useRef<(() => Promise<void>) | null>(null);

  const scheduleRefresh = useCallback((expiresInMs: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = Math.max(expiresInMs - 60_000, 5_000);
    refreshTimerRef.current = setTimeout(() => {
      refreshTokensRef.current?.().catch(() => {
        accessTokenRef.current = null;
        setIsAuthenticated(false);
        setUser(null);
      });
    }, delay);
  }, []);

  const parseTokenExpiry = (token: string): number => {
    const payload = parseJwtPayload(token);
    if (payload?.exp) return (payload.exp * 1000) - Date.now();
    return 14 * 60 * 1000;
  };

  const refreshTokens = useCallback(async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error('No refresh token');

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      throw new Error('Refresh failed');
    }

    const data = await parseJsonResponse<TokenPair>(res);
    setTokenAndUser(data.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setIsAuthenticated(true);
    scheduleRefresh(parseTokenExpiry(data.accessToken));
  }, [scheduleRefresh]);

  useEffect(() => {
    refreshTokensRef.current = refreshTokens;
  }, [refreshTokens]);

  useEffect(() => {
    /*
     * `void`, weil dieser IIFE nicht ablehnen kann: der `try` umspannt jedes
     * `await`, und danach folgt nur noch `setLoading(false)`. Es fehlt hier also
     * keine Fehlerbehandlung — sie steht im `catch` darunter.
     *
     * Ein `AbortController` gehörte fachlich dazu (Unmount während des
     * Bootstrap-Requests), würde aber den Auth-Ablauf verändern und ist deshalb
     * bewusst nicht Teil dieser Aufräumrunde.
     */
    void (async () => {
      try {
        const res = await fetch('/api/auth/status');
        const status = await parseJsonResponse<AuthStatus>(res);
        setAuthEnabled(status.enabled);

        if (!status.enabled) {
          setIsAuthenticated(true);
          setLoading(false);
          return;
        }

        const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
        if (refreshToken) {
          await refreshTokens();
        }
      } catch {
        setAuthEnabled(true);
      }
      setLoading(false);
    })();

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refreshTokens]);

  const login = async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      /*
       * Gleiche Fallback-Kette wie vorher: Meldung aus dem Body, sonst der
       * i18n-Text. `readErrorMessageFromText` liefert `undefined`, wenn der Body
       * kein JSON ist oder kein nichtleeres `message` enthält — genau die zwei
       * Fälle, die vorher am `|| i18n.t(...)` hingen.
       */
      const text = await res.text().catch(() => '');
      throw new Error(readErrorMessageFromText(text) ?? i18n.t('auth.loginFailed'));
    }

    const data = await parseJsonResponse<TokenPair>(res);
    setTokenAndUser(data.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setIsAuthenticated(true);
    scheduleRefresh(parseTokenExpiry(data.accessToken));
  };

  const logout = async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (refreshToken && accessTokenRef.current) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessTokenRef.current}`,
        },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    accessTokenRef.current = null;
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    setIsAuthenticated(false);
    setUser(null);
  };

  const getAccessToken = () => accessTokenRef.current;

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        authEnabled,
        loading,
        user,
        login,
        logout,
        getAccessToken,
        applyAccessToken: setTokenAndUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
