import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { INSTANCE, MASTER_PATH, scopedKey } from '../lib/instance';
import { api, ApiError, SESSION_EXPIRED_EVENT } from '../lib/api';
import i18n from '../i18n';

export type Role = 'ADMIN' | 'MACHINIST';

export interface User {
  id: string;
  username: string;
  role: Role;
}

type Status = 'loading' | 'ready';

interface AuthContextType {
  user: User | null;
  status: Status;
  /** True when the database has no accounts yet (first deploy). */
  needsSetup: boolean;
  /**
   * This country (or the master hub) has no accounts and cannot be set up from the login page:
   * its first account is created by the master admin (or, for the master, by a Moroccan admin).
   */
  notConfigured: boolean;
  /** The password used to sign in does not meet the current rules; shown as a reminder banner. */
  weakPassword: boolean;
  dismissWeakPassword: () => void;
  /** Two-step sign-in is on for the signed-in account. */
  mfaEnabled: boolean;
  setMfaEnabled: (on: boolean) => void;
  /** Password accepted; waiting for the authenticator code. */
  mfaPending: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  verifyMfa: (code: string) => Promise<{ success: boolean; error?: string; expired?: boolean }>;
  cancelMfa: () => void;
  setup: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// The last signed-in user is remembered per device so the app still opens
// (read-only data from cache) when the network is briefly down.
const USER_CACHE_KEY = scopedKey('cnc-session-user');

function readCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    const u = raw ? JSON.parse(raw) : null;
    return u && typeof u.username === 'string' && typeof u.id === 'string' ? u : null;
  } catch {
    return null;
  }
}

function writeCachedUser(u: User | null) {
  try {
    if (u) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [weakPassword, setWeakPassword] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  // `master`: the password belonged to the master admin, so the code is checked by the master hub.
  const [challenge, setChallenge] = useState<{ token: string; weak: boolean; master: boolean } | null>(null);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    writeCachedUser(u);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ user: User | null; needsSetup?: boolean; notConfigured?: boolean; mfaEnabled?: boolean }>('/auth/me')
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setMfaEnabled(!!res.mfaEnabled);
        setNotConfigured(!res.user && !!res.notConfigured);
        setNeedsSetup(!res.user && !!res.needsSetup);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.offline) {
          setUserState(readCachedUser());
        } else {
          setUser(null);
          setNeedsSetup(!!err?.data?.needsSetup);
        }
      })
      .finally(() => {
        if (!cancelled) setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [setUser]);

  const login = async (username: string, password: string) => {
    try {
      const res = await api<{ user?: User; weakPassword?: boolean; mfaRequired?: boolean; challenge?: string; mfaEnabled?: boolean; master?: boolean }>(
        '/auth/login',
        { method: 'POST', body: { username: username.trim(), password } },
      );
      setNeedsSetup(false);
      if (res.mfaRequired && res.challenge) {
        setChallenge({ token: res.challenge, weak: !!res.weakPassword, master: !!res.master });
        return { success: true };
      }
      // The master admin signed in from a country's page: open the master dashboard.
      if (res.master && INSTANCE.kind !== 'master') {
        window.location.assign(MASTER_PATH);
        return { success: true };
      }
      setWeakPassword(!!res.weakPassword);
      setMfaEnabled(!!res.mfaEnabled);
      setUser(res.user ?? null);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || i18n.t('app:auth.loginFailed') };
    }
  };

  const verifyMfa = async (code: string) => {
    if (!challenge) return { success: false, expired: true, error: i18n.t('app:auth.signInExpired') };
    try {
      const res = await api<{ user: User; weakPassword?: boolean }>('/auth/mfa/verify', {
        method: 'POST',
        body: { challenge: challenge.token, code: code.trim(), weakPassword: challenge.weak },
        base: challenge.master ? '/master/api' : undefined,
      });
      setChallenge(null);
      if (challenge.master && INSTANCE.kind !== 'master') {
        window.location.assign(MASTER_PATH);
        return { success: true };
      }
      setWeakPassword(!!res.weakPassword);
      setMfaEnabled(true);
      setUser(res.user);
      return { success: true };
    } catch (err: any) {
      // The server message is translated for Turkish pages ("Giriş süresi doldu...").
      // The server marks this case with a code, so it works whatever the message language is.
      const expired = err instanceof ApiError && err.status === 401 && err.data?.code === 'challenge_expired';
      if (expired) setChallenge(null);
      return { success: false, expired, error: err?.message || i18n.t('app:auth.wrongCode') };
    }
  };

  const setup = async (username: string, password: string) => {
    try {
      const res = await api<{ user: User }>('/auth/setup', { method: 'POST', body: { username: username.trim(), password } });
      setNeedsSetup(false);
      setUser(res.user);
      return { success: true };
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) setNeedsSetup(false);
      return { success: false, error: err?.message || i18n.t('app:auth.setupFailed') };
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* sign out locally even if the server is unreachable */
    }
    setWeakPassword(false);
    setMfaEnabled(false);
    setUser(null);
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
    setWeakPassword(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        status,
        needsSetup,
        notConfigured,
        weakPassword,
        dismissWeakPassword: () => setWeakPassword(false),
        mfaEnabled,
        setMfaEnabled,
        mfaPending: !!challenge,
        login,
        verifyMfa,
        cancelMfa: () => setChallenge(null),
        setup,
        logout,
        changePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
