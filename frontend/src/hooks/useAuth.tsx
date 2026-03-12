import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';

interface UserInfo {
  userId: string;
  username: string;
  role: string;
}

interface AuthState {
  isAuthenticated: boolean;
  authEnabled: boolean | null;
  loading: boolean;
  user: UserInfo | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthState>(null!);

const REFRESH_TOKEN_KEY = 'devgrimoire_refresh_token';

function parseJwtPayload(token: string): any {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
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
      setUser({ userId: payload.sub, username: payload.username, role: payload.role });
    }
  };

  const scheduleRefresh = useCallback((expiresInMs: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = Math.max(expiresInMs - 60_000, 5_000);
    refreshTimerRef.current = setTimeout(() => {
      refreshTokens().catch(() => {
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

    const data = await res.json();
    setTokenAndUser(data.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setIsAuthenticated(true);
    scheduleRefresh(parseTokenExpiry(data.accessToken));
  }, [scheduleRefresh]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/status');
        const status = await res.json();
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
      const err = await res.json().catch(() => ({ message: 'Login fehlgeschlagen' }));
      throw new Error(err.message || 'Login fehlgeschlagen');
    }

    const data = await res.json();
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
    <AuthContext.Provider value={{ isAuthenticated, authEnabled, loading, user, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
