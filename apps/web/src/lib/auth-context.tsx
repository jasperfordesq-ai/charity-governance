'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, establishSession, logoutSession } from './api';
import type { UserResponse } from '@charitypilot/shared';

interface AuthContextType {
  user: (UserResponse & { mfaEnrolmentRequired?: boolean }) | null;
  isLoading: boolean;
  login: (email: string, password: string, secondFactor?: string) => Promise<UserResponse & { mfaEnrolmentRequired?: boolean }>;
  register: (data: { email: string; password: string; name: string; organisationName: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<(UserResponse & { mfaEnrolmentRequired?: boolean }) | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me', {
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

  const login = async (email: string, password: string, secondFactor?: string) => {
    const offered = secondFactor?.trim();
    const { data } = await establishSession(() => api.post('/auth/login', {
      email, password,
      ...(offered ? /^\d{6}$/.test(offered) ? { code: offered } : { recoveryCode: offered } : {}),
    }, {
      skipAuthRefresh: true,
      skipAuthRedirect: true,
    }));
    const loggedInUser = { ...data.user, mfaEnrolmentRequired: data.mfaEnrolmentRequired === true };
    setUser(loggedInUser);
    return loggedInUser;
  };

  const register = async (regData: {
    email: string;
    password: string;
    name: string;
    organisationName: string;
  }) => {
    await api.post('/auth/register', regData, {
      skipAuthRefresh: true,
      skipAuthRedirect: true,
    });
    setUser(null);
  };

  const logout = async () => {
    await logoutSession();
    setUser(null);
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
