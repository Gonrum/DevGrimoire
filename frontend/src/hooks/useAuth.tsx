import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';

interface AuthState {
  isAuthenticated: boolean;
  authEnabled: boolean | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthState>(null!);

const REFRESH_TOKEN_KEY = 'claudevault_refresh_token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const accessTokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const scheduleRefresh = useCallback((expiresInMs: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    // Refresh 1 minute before expiry
    const delay = Math.max(expiresInMs - 60_000, 5_000);
    refreshTimerRef.current = setTimeout(() => {
      refreshTokens().catch(() => {
        accessTokenRef.current = null;
        setIsAuthenticated(false);
      });
    }, delay);
  }, []);

  const parseTokenExpiry = (token: string): number => {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return (payload.exp * 1000) - Date.now();
    } catch {
      return 14 * 60 * 1000; // fallback 14min
    }
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
    accessTokenRef.current = data.accessToken;
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setIsAuthenticated(true);
    scheduleRefresh(parseTokenExpiry(data.accessToken));
  }, [scheduleRefresh]);

  // Check auth status on mount
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

        // Try to restore session via refresh token
        const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
        if (refreshToken) {
          await refreshTokens();
        }
      } catch {
        // Backend not reachable — assume auth enabled
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
    accessTokenRef.current = data.accessToken;
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
  };

  const getAccessToken = () => accessTokenRef.current;

  return (
    <AuthContext.Provider value={{ isAuthenticated, authEnabled, loading, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
