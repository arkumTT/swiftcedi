import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from '../lib/apiClient';
import type { CurrentUser } from '../types/api';

interface AuthContextValue {
  user: CurrentUser | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (codes: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setStatus('unauthenticated');
      return;
    }
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      setUser(me);
      setStatus('authenticated');
    } catch {
      setToken(null);
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { token } = await api.post<{ token: string }>('/auth/login', { email, password });
      setToken(token);
      await loadMe();
    },
    [loadMe]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setToken(null);
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const hasPermission = useCallback((code: string) => Boolean(user?.permissions.includes(code)), [user]);
  const hasAnyPermission = useCallback(
    (codes: string[]) => Boolean(user && codes.some((c) => user.permissions.includes(c))),
    [user]
  );

  return (
    <AuthContext.Provider value={{ user, status, login, logout, hasPermission, hasAnyPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
