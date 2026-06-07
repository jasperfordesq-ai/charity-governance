'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api } from './api';
import type { UserResponse } from '@charitypilot/shared';

interface AuthContextType {
  user: UserResponse | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<UserResponse>;
  register: (data: { email: string; password: string; name: string; organisationName: string }) => Promise<UserResponse>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me', {
        skipAuthRefresh: true,
        skipAuthRedirect: true,
      });
      setUser(data);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setIsLoading(false));
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const { data } = await api.post('/auth/login', { email, password }, {
      skipAuthRefresh: true,
      skipAuthRedirect: true,
    });
    setUser(data.user);
    return data.user;
  };

  const register = async (regData: {
    email: string;
    password: string;
    name: string;
    organisationName: string;
  }) => {
    const { data } = await api.post('/auth/register', regData, {
      skipAuthRefresh: true,
      skipAuthRedirect: true,
    });
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout', {});
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
