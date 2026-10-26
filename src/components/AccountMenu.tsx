import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, KeyRound, LogOut, Monitor, Moon, RefreshCw, Sun } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { iosMenu } from '../lib/motion';
import { TimeWonClock } from './TimeWonClock';
import { useT } from '../i18n';

const THEME_ORDER: ThemeMode[] = ['dark', 'light', 'system'];
const item =
  'no-glass flex w-full items-center gap-2.5 px-3 min-h-11 rounded-[var(--radius-md)] text-sm text-left text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.06)] focus-visible:bg-[rgba(var(--ov),0.06)]';

/**
 * The user chip in the header opens this menu. On phones it holds what the header has no room for
 * (time saved, security, theme, sync, sign out); on every screen it shows the app version.
 */
export function AccountMenu({ onSecurity, onSync, syncing, onTimeSaved }: { onSecurity: () => void; onSync: () => void; syncing: boolean; onTimeSaved: () => void }) {
  const { t } = useT('app');
  const { user, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  const close = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        aria-label={t('account.open', { name: user.username })}
        onClick={() => setOpen((v) => !v)}
        className="no-glass flex items-center gap-2 py-1 px-1 sm:px-3 rounded-full border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.04)] hover:bg-[rgba(var(--ov),0.08)] transition-colors"
      >
        <span className="w-7 h-7 rounded-full bg-gradient-to-br from-[var(--blue-500)] to-[var(--blue-600)] flex items-center justify-center text-white font-bold text-xs uppercase shadow-xs">
          {user.username.slice(0, 2)}
        </span>
        <span className="hidden sm:flex flex-col text-left leading-none">
          <span className="text-xs font-semibold text-[var(--text-primary)]">{user.username}</span>
          <span className="text-xs uppercase tracking-wider font-semibold text-[var(--text-tertiary)] mt-0.5">{t(`common:role.${user.role}`)}</span>
        </span>
        <ChevronDown size={14} className={`hidden sm:block text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id="account-menu"
            {...iosMenu}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] glass-modal !bg-[var(--bg-card)] p-2 z-50 rounded-[var(--radius-lg)] shadow-2xl"
          >
            <div className="px-3 pt-1.5 pb-2.5 mb-1 border-b border-[var(--border-subtle)]">
              <div className="text-sm font-semibold text-[var(--text-primary)]">{user.username}</div>
              <div className="text-xs uppercase tracking-wider font-semibold text-[var(--text-tertiary)]">{t(`common:role.${user.role}`)}</div>
            </div>
            <div className="sm:hidden px-1 py-1.5">
              <TimeWonClock compact onClick={close(onTimeSaved)} />
            </div>
            <button type="button" className={item} onClick={close(onSecurity)}>
              <KeyRound size={16} className="text-[var(--text-secondary)]" /> {t('account.security')}
            </button>
            <button type="button" className={item} onClick={() => setMode(next)}>
              <ThemeIcon size={16} className="text-[var(--text-secondary)]" /> {t(`theme.label.${mode}`)}
            </button>
            <button type="button" className={item} onClick={onSync}>
              <RefreshCw size={16} className={`text-[var(--text-secondary)] ${syncing ? 'animate-spin' : ''}`} /> {t('header.syncNow')}
            </button>
            <button type="button" className={`${item} !text-[var(--rose-500)]`} onClick={logout}>
              <LogOut size={16} /> {t('header.signOut')}
            </button>
            <div className="px-3 pt-2 mt-1 border-t border-[var(--border-subtle)] text-xs text-[var(--text-tertiary)] font-mono">
              {t('account.version', { version: __APP_VERSION__ })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
