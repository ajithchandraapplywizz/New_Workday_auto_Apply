import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import {
  syncLiveCAData,
  authLogin,
  authSetupConfirm,
  authHeartbeat,
  authLogout,
} from '../services/api';

const AuthContext = createContext(null);

import { getYesterdayDateStr, getPreviousWorkdayDateStr, getTodayDateStr } from '../utils/dateUtils';
export { getYesterdayDateStr, getPreviousWorkdayDateStr, getTodayDateStr };

/**
 * Helper: Parse and validate backend JWT payload
 */
function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const payload = JSON.parse(jsonStr);
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  // Session strictly initialized from backend JWT token in localStorage
  const [user, setUser] = useState(() => {
    try {
      const token = localStorage.getItem('applywizz_auth_token');
      const payload = parseJwtPayload(token);
      if (payload && payload.email) {
        return {
          id: payload.sub || payload.id,
          email: payload.email,
          name: payload.name || payload.email.split('@')[0],
          role: payload.role,
          manager_id: payload.manager_id,
          baseRole: payload.role,
        };
      }
      localStorage.removeItem('applywizz_auth_token');
      localStorage.removeItem('applywizz_auth_session');
      return null;
    } catch {
      return null;
    }
  });

  // Default to today's date for live day-to-day dynamic monitoring across dashboards
  const [date, setDate] = useState(getTodayDateStr());
  const [timeframe, setTimeframe] = useState('day');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isVerifyingSession, setIsVerifyingSession] = useState(() => {
    try {
      const token = localStorage.getItem('applywizz_auth_token');
      return Boolean(token);
    } catch {
      return false;
    }
  });

  // Smart Auto-Sync state: 'idle' | 'syncing' | 'synced' | 'failed'
  const [smartSyncStatus, setSmartSyncStatus] = useState('idle');
  const [smartSyncMessage, setSmartSyncMessage] = useState('');

  // Persist session changes
  useEffect(() => {
    if (user) {
      localStorage.setItem('applywizz_auth_session', JSON.stringify(user));
    } else {
      localStorage.removeItem('applywizz_auth_session');
    }
  }, [user]);

  // Strict session verification on load
  useEffect(() => {
    const token = localStorage.getItem('applywizz_auth_token');
    const payload = parseJwtPayload(token);
    if (!payload || !payload.email) {
      localStorage.removeItem('applywizz_auth_token');
      localStorage.removeItem('applywizz_auth_session');
      setUser(null);
      setIsVerifyingSession(false);
      return;
    }

    const allowedRoles = ['admin', 'developer', 'dev'];
    const r = (payload.role || '').toLowerCase();
    if (!allowedRoles.includes(r)) {
      console.warn('[SECURITY] Denying access to non-admin/dev session:', payload.email);
      localStorage.removeItem('applywizz_auth_token');
      localStorage.removeItem('applywizz_auth_session');
      setUser(null);
      setAuthError('Access denied: Only admin and developer accounts are permitted.');
      setIsVerifyingSession(false);
      return;
    }

    setIsVerifyingSession(false);
  }, []);

  // Global 401 Session Expiration listener
  useEffect(() => {
    const handleExpired = () => {
      localStorage.removeItem('applywizz_auth_token');
      localStorage.removeItem('applywizz_auth_session');
      setUser(null);
      setAuthError('Session expired. Please sign in again.');
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  // Periodic Backend Heartbeat (JWT authenticated, FRONTEND_HEARTBEAT_MS = 45s)
  useEffect(() => {
    if (!user?.email) return;

    let isMounted = true;
    const FRONTEND_HEARTBEAT_MS = 45 * 1000;

    const performHeartbeat = async () => {
      const currentToken = localStorage.getItem('applywizz_auth_token');
      if (!currentToken) return;
      try {
        const res = await authHeartbeat(currentToken);
        if (res?.status === 401 || res?.error?.toLowerCase()?.includes('unauthorized')) {
          console.warn('[AUTH] Heartbeat 401: Session expired. Logging out.');
          if (isMounted) {
            localStorage.removeItem('applywizz_auth_token');
            localStorage.removeItem('applywizz_auth_session');
            setUser(null);
            setAuthError('Session expired. Please sign in again.');
          }
        }
      } catch (err) {
        console.warn('[AUTH] Heartbeat error:', err);
      }
    };

    performHeartbeat();
    const heartbeatTimer = setInterval(performHeartbeat, FRONTEND_HEARTBEAT_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        performHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(heartbeatTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user?.email]);

  /**
   * Secure Server-Side Login via Microsoft Authenticator TOTP
   */
  const loginWithMfa = async ({ email, code }) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanCode = String(code || '').trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Please enter a valid work email address');
    }
    if (!cleanCode || cleanCode.length !== 6) {
      throw new Error('Please enter your 6-digit access code');
    }

    const res = await authLogin({ email: cleanEmail, code: cleanCode });
    if (!res?.token) {
      throw new Error(res?.error || 'Authentication failed');
    }

    localStorage.setItem('applywizz_auth_token', res.token);
    const payload = parseJwtPayload(res.token);

    const sessionUser = {
      id: payload?.sub || payload?.id || res.user?.id,
      email: cleanEmail,
      name: payload?.name || res.user?.name || cleanEmail.split('@')[0],
      role: payload?.role || res.user?.role || 'developer',
      baseRole: payload?.role || res.user?.role || 'developer',
      date,
      timeframe,
    };

    localStorage.setItem('applywizz_auth_session', JSON.stringify(sessionUser));
    setUser(sessionUser);
    setAuthError('');
    setIsAuthModalOpen(false);

    return sessionUser;
  };

  /**
   * Secure Server-Side Confirmation for First-Time MFA Setup
   */
  const confirmMfaSetup = async ({ email, code }) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanCode = String(code || '').trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Please enter a valid work email address');
    }
    if (!cleanCode || cleanCode.length !== 6) {
      throw new Error('Please enter the 6-digit code shown in Microsoft Authenticator');
    }

    const res = await authSetupConfirm({ email: cleanEmail, code: cleanCode });
    if (!res?.token) {
      throw new Error(res?.error || 'Confirmation failed');
    }

    localStorage.setItem('applywizz_auth_token', res.token);
    const payload = parseJwtPayload(res.token);

    const sessionUser = {
      id: payload?.sub || payload?.id || res.user?.id,
      email: cleanEmail,
      name: payload?.name || res.user?.name || cleanEmail.split('@')[0],
      role: payload?.role || res.user?.role || 'ca',
      manager_id: payload?.manager_id || res.user?.manager_id,
      baseRole: payload?.role || res.user?.role || 'ca',
      date,
      timeframe,
    };

    localStorage.setItem('applywizz_auth_session', JSON.stringify(sessionUser));
    setUser(sessionUser);
    setAuthError('');
    setIsAuthModalOpen(false);

    return sessionUser;
  };

  /**
   * Backward compatibility wrappers
   */
  const loginWithCredentials = async ({ email, code }) => {
    return loginWithMfa({ email, code });
  };

  const loginWithAuthenticator = async ({ email, code }) => {
    return loginWithMfa({ email, code });
  };

  /**
   * Switch Role (Strictly restricted to Developer Ajith)
   */
  const switchRole = (newRole) => {
    const isDev =
      user?.baseRole === 'dev' ||
      user?.role === 'dev' ||
      user?.email === 'ajithchandranimmala@applywizz.ai';
    if (!isDev) return;
    setUser((prev) => ({
      ...prev,
      baseRole: 'dev',
      role: newRole,
    }));
  };

  /**
   * Logout user and revoke active session
   */
  const logout = async () => {
    const token = localStorage.getItem('applywizz_auth_token');
    if (token) {
      try {
        await authLogout(token);
      } catch (err) {
        console.warn('Backend logout error:', err);
      }
    }
    localStorage.removeItem('applywizz_auth_token');
    localStorage.removeItem('applywizz_auth_session');
    setUser(null);
    setAuthError('');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        setUser,
        authError,
        setAuthError,
        isVerifyingSession,
        switchRole,
        logout,
        date,
        setDate,
        timeframe,
        setTimeframe,
        isAuthModalOpen,
        setIsAuthModalOpen,
        loginWithMfa,
        confirmMfaSetup,
        loginWithCredentials,
        loginWithAuthenticator,
        smartSyncStatus,
        smartSyncMessage,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
