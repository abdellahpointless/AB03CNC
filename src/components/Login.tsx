import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Lock, User as UserIcon, ArrowRight, ShieldCheck, Smartphone, Crown, Globe2 } from 'lucide-react';
import { Flag } from './Flag';
import { CHOOSE_COUNTRY_PATH, INSTANCE } from '../lib/instance';
import { scannedMachine } from '../lib/phoneCheck';
import { QrCode } from 'lucide-react';
import { motion, useAnimate } from 'motion/react';
import { useT } from '../i18n';

export default function Login() {
  const { t } = useT('app');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login, setup, needsSetup, notConfigured, mfaPending, verifyMfa, cancelMfa } = useAuth();
  const isMasterPage = INSTANCE.kind === 'master';
  const region = INSTANCE.kind === 'country' ? INSTANCE.region : null;
  const [code, setCode] = useState('');
  const scanned = scannedMachine();
  const [useRecovery, setUseRecovery] = useState(false);
  const [cardRef, animateCard] = useAnimate();
  // iPhone-style "wrong passcode" shake.
  const shake = () => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !cardRef.current) return;
    animateCard(cardRef.current, { x: [0, -14, 12, -9, 6, -3, 0] }, { duration: 0.5, ease: 'easeOut' });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    if (needsSetup && password !== confirmPassword) {
      setError(t('login.passwordsMismatch'));
      shake();
      return;
    }
    setIsLoading(true);
    const res = needsSetup ? await setup(username, password) : await login(username, password);
    setIsLoading(false);
    if (!res.success) {
      setError(res.error || t('auth.loginFailed'));
      shake();
    }
  };

  const handleCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    setIsLoading(true);
    const res = await verifyMfa(code);
    setIsLoading(false);
    if (!res.success) {
      setError(res.error || t('auth.wrongCode'));
      setCode('');
      shake();
    }
  };

  const backToPassword = () => {
    cancelMfa();
    setCode('');
    setPassword('');
    setError('');
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      {/* Aurora Ambient Glow Spots */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-[var(--blue-500)] opacity-10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[300px] bg-[var(--green-500)] opacity-5 blur-[100px] rounded-full pointer-events-none" />

      <motion.div 
        ref={cardRef}
        initial={{ opacity: 0, scale: 0.9, y: 16, filter: 'blur(10px)' }} 
        animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
        transition={{ type: 'spring', duration: 0.6, bounce: 0.2 }}
        className="max-w-md w-full glass-panel relative z-10 p-8 sm:p-10"
      >
        <div className="flex flex-col items-center mb-8">
          {/* Logo mark: rounded-square (--radius-md) filled with diagonal gradient (blue -> violet) + solid green dot pinned to corner */}
          <div className="relative mb-4">
            <div className="w-14 h-14 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--blue-500)] to-indigo-700 flex items-center justify-center text-white font-mono font-extrabold text-xl shadow-[0_8px_20px_rgba(59,111,212,0.4)]">
              //
            </div>
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--green-500)] border-2 border-[var(--bg-panel)] shadow-[0_0_8px_var(--green-glow)]" />
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            CNC Process Pro
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="badge-neutral text-[11px] py-0.5 px-2">v6.0 Aurora</span>
            <span className="text-xs text-[var(--text-secondary)]">{t('login.tagline')}</span>
          </div>
          {/* Which instance this is: a country (flag) or the master dashboard; and the way back to the country picker. */}
          <div className="flex items-center gap-2 mt-4">
            {region ? (
              <span className="badge-neutral text-xs py-1 px-2.5 inline-flex items-center gap-2">
                <Flag country={region.id} className="w-5 h-[14px] rounded-[3px] shadow-sm" />
                <span className="font-semibold text-[var(--text-primary)]">{t(`common:country.${region.id}`)}</span>
              </span>
            ) : (
              <span className="badge-neutral text-xs py-1 px-2.5 inline-flex items-center gap-1.5">
                <Crown size={13} className="text-amber-500" />
                <span className="font-semibold text-[var(--text-primary)]">{t('common:role.MASTER')}</span>
              </span>
            )}
            <a href={CHOOSE_COUNTRY_PATH} className="text-[11px] text-[var(--blue-500)] hover:underline inline-flex items-center gap-1">
              <Globe2 size={12} /> {t('common:actions.changeCountry')}
            </a>
          </div>
        </div>

        {/* Opened from a machine's QR code: say where signing in leads. */}
        {scanned && !isMasterPage && (
          <div className="mb-5 p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 text-sm text-[var(--text-primary)] flex items-center gap-2.5">
            <QrCode size={18} className="shrink-0 text-[var(--blue-500)]" />
            <span>{t('login.scanHint', { machine: scanned })}</span>
          </div>
        )}

        {notConfigured && !mfaPending && (
          <div className="mb-5 p-3 rounded-[var(--radius-md)] bg-[rgba(224,138,77,0.1)] border border-[var(--orange-500)]/30 text-xs text-[var(--text-secondary)] leading-relaxed">
            {isMasterPage ? (
              <>
                <strong className="text-[var(--text-primary)]">{t('login.noMasterTitle')}</strong> {t('login.noMasterBody')}
              </>
            ) : (
              <>
                <strong className="text-[var(--text-primary)]">{t('login.notSetUpTitle')}</strong> {t('login.notSetUpBody')}
              </>
            )}
          </div>
        )}

        {needsSetup && (
          <div className="mb-5 p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 text-xs text-[var(--text-secondary)] leading-relaxed">
            <strong className="text-[var(--text-primary)]">{t('login.setupTitle')}</strong> {t('login.setupBody')}
          </div>
        )}

        {mfaPending ? (
          <form onSubmit={handleCode} className="space-y-5">
            <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 text-xs text-[var(--text-secondary)] leading-relaxed">
              <Smartphone size={18} className="shrink-0 text-[var(--blue-500)] mt-0.5" />
              <span>
                {useRecovery ? t('login.recoveryHint') : t('login.appHint')}
              </span>
            </div>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0.3 }}
                className="badge-danger w-full justify-center py-2 text-xs"
              >
                <span>{error}</span>
              </motion.div>
            )}
            <div className="space-y-1.5">
              <label className="section-label">{useRecovery ? t('login.recoveryCode') : t('login.authenticatorCode')}</label>
              <input
                key={useRecovery ? 'rec' : 'otp'}
                type="text"
                value={code}
                onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase().slice(0, 12) : e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="aurora-input w-full text-center font-mono text-lg tracking-[0.35em]"
                placeholder={useRecovery ? 'XXXX-XXXX' : '000000'}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </div>
            <button type="submit" disabled={isLoading || code.length < (useRecovery ? 8 : 6)} className="btn-primary w-full py-3 text-sm font-semibold">
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('login.checking')}
                </span>
              ) : (
                <>
                  <span>{t('login.verifyAndSignIn')}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={backToPassword} className="no-glass text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                &larr; {t('common:actions.back')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError('');
                }}
                className="no-glass text-[var(--blue-500)] hover:underline"
              >
                {useRecovery ? t('login.useApp') : t('login.useRecovery')}
              </button>
            </div>
          </form>
        ) : (
        <form onSubmit={handleLogin} className="space-y-5">
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.3 }}
              className="badge-danger w-full justify-center py-2 text-xs"
            >
              <span>{error}</span>
            </motion.div>
          )}

          <div className="space-y-1.5">
            <label className="section-label">{t('login.username')}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[var(--text-tertiary)]">
                <UserIcon size={16} />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="aurora-input w-full pl-10"
                placeholder={needsSetup ? t('login.usernameSetupPlaceholder') : t('login.usernamePlaceholder')}
                autoComplete="username"
                required
                autoFocus
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="section-label">{t('login.password')}</label>
              <span className="text-[11px] text-[var(--text-tertiary)]">{needsSetup ? t('login.minTenChars') : t('login.secureAccess')}</span>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[var(--text-tertiary)]">
                <Lock size={16} />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="aurora-input w-full pl-10"
                placeholder="••••••••"
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                minLength={needsSetup ? 10 : undefined}
                required
              />
            </div>
          </div>

          {needsSetup && (
            <div className="space-y-1.5">
              <label className="section-label">{t('login.confirmPassword')}</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[var(--text-tertiary)]">
                  <Lock size={16} />
                </div>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="aurora-input w-full pl-10"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="btn-primary w-full py-3 mt-2 text-sm font-semibold"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {needsSetup ? t('login.creatingAccount') : t('login.signingIn')}
              </span>
            ) : (
              <>
                <span>{needsSetup ? t('login.createAdmin') : t('login.signInToSystem')}</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
        )}

        <div className="mt-8 pt-6 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-tertiary)]">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-[var(--green-500)]" />
            <span>{t('login.roleBasedSecurity')}</span>
          </div>
          <span>CNC Studio v6.0</span>
        </div>
      </motion.div>
    </main>
  );
}
