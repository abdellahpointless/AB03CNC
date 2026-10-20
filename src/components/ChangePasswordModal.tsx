import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff, Smartphone, X } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useAuth } from '../contexts/AuthContext';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import { iosBackdrop, iosSurface } from '../lib/motion';

type Tab = 'password' | 'mfa';

/** Scannable QR code drawn as one SVG path (no images, nothing sent to a third party). */
function QrCode({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d: path, size: n + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-44 h-44 rounded-[var(--radius-md)]" shapeRendering="crispEdges" role="img" aria-label="QR code for the authenticator app">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function PasswordForm() {
  const { changePassword, user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const min = user?.role === 'ADMIN' ? 10 : 8;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('The new passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <div className="badge-positive w-full py-2 px-3 text-xs">Password changed. Other PCs using this account were signed out.</div>;
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <input type="password" className="aurora-input w-full text-xs" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
      <input type="password" className="aurora-input w-full text-xs" placeholder={`New password (at least ${min} characters)`} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={min} maxLength={200} required />
      <input type="password" className="aurora-input w-full text-xs" placeholder="Repeat new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
        A short sentence is easier to remember and harder to guess than a single word. Avoid your username and common passwords.
      </p>
      {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
      <button type="submit" disabled={busy} className="btn-primary w-full text-xs py-2">{busy ? 'Saving...' : 'Change password'}</button>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `CNC Process Pro recovery codes\nEach code can be used once if you lose your phone.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cnc-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="badge-positive w-full py-2 px-3 text-xs">Two-step sign-in is on.</div>
      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
        Save these recovery codes somewhere safe (printed, or in a password manager). If you lose your phone, each code lets you sign in once.
        <strong className="text-[var(--text-primary)]"> They are shown only now.</strong>
      </p>
      <div className="grid grid-cols-2 gap-2 p-3 rounded-[var(--radius-md)] bg-[var(--bg-input)] border border-[var(--border-subtle)] font-mono text-sm text-center text-[var(--text-primary)]">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className="btn-secondary flex-1 text-xs py-2">
          {copied ? <Check size={13} /> : <Copy size={13} />} <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button type="button" onClick={download} className="btn-secondary flex-1 text-xs py-2">
          <Download size={13} /> <span>Download</span>
        </button>
      </div>
      <button type="button" onClick={onDone} className="btn-primary w-full text-xs py-2">I saved them</button>
    </div>
  );
}

function MfaPanel() {
  const { mfaEnabled, setMfaEnabled } = useAuth();
  const [setupData, setSetupData] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  if (recovery) return <RecoveryCodes codes={recovery} onDone={() => setRecovery(null)} />;

  if (mfaEnabled) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api('/auth/mfa/disable', { method: 'POST', body: { password, code } });
            setMfaEnabled(false);
            setPassword('');
            setCode('');
          });
        }}
        className="space-y-3"
      >
        <div className="flex items-center gap-2 badge-positive w-full py-2 px-3 text-xs">
          <ShieldCheck size={14} /> <span>Two-step sign-in is on for this account.</span>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">To turn it off, confirm your password and a current code (or a recovery code).</p>
        <input type="password" className="aurora-input w-full text-xs" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <input type="text" className="aurora-input w-full text-xs font-mono" placeholder="6-digit code or recovery code" value={code} onChange={(e) => setCode(e.target.value.slice(0, 12))} autoComplete="one-time-code" required />
        {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
        <button type="submit" disabled={busy} className="btn-danger w-full text-xs py-2">
          <ShieldOff size={13} /> <span>{busy ? 'Turning off...' : 'Turn off two-step sign-in'}</span>
        </button>
      </form>
    );
  }

  if (!setupData) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 text-xs text-[var(--text-secondary)] leading-relaxed">
          <Smartphone size={18} className="shrink-0 text-[var(--blue-500)] mt-0.5" />
          <span>
            With two-step sign-in, your password alone is not enough: you also enter a 6-digit code from an authenticator app on your phone
            (Google Authenticator, Microsoft Authenticator, Authy, 1Password...). Strongly recommended for admin accounts.
          </span>
        </div>
        {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
        <button
          type="button"
          disabled={busy}
          onClick={() => run(async () => setSetupData(await api('/auth/mfa/setup', { method: 'POST' })))}
          className="btn-primary w-full text-xs py-2"
        >
          <ShieldCheck size={13} /> <span>{busy ? 'Preparing...' : 'Turn on two-step sign-in'}</span>
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const res = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { method: 'POST', body: { password, code } });
          setMfaEnabled(true);
          setSetupData(null);
          setRecovery(res.recoveryCodes);
        });
      }}
      className="space-y-3"
    >
      <p className="text-xs text-[var(--text-secondary)]">1. Scan this code with your authenticator app.</p>
      <div className="flex justify-center"><QrCode text={setupData.otpauth} /></div>
      <details className="text-[11px] text-[var(--text-tertiary)]">
        <summary className="cursor-pointer">Can't scan? Enter this key by hand</summary>
        <code className="block mt-1 break-all font-mono text-[var(--text-primary)] select-all">{setupData.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </details>
      <p className="text-xs text-[var(--text-secondary)]">2. Enter the 6-digit code it shows, and your password.</p>
      <input type="text" inputMode="numeric" className="aurora-input w-full text-center font-mono text-lg tracking-[0.35em]" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" required autoFocus />
      <input type="password" className="aurora-input w-full text-xs" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
      <button type="submit" disabled={busy || code.length !== 6} className="btn-primary w-full text-xs py-2">{busy ? 'Checking...' : 'Confirm and turn on'}</button>
    </form>
  );
}

/** "Security" sheet: change password and manage two-step sign-in. */
export function ChangePasswordModal({ onClose, initialTab = 'password' }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return createPortal(
    <motion.div
      className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      {...iosBackdrop}
    >
      <motion.div className="glass-modal max-w-sm w-full p-6 max-h-[92vh] overflow-y-auto" {...iosSurface}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
            <ShieldCheck size={16} className="text-[var(--accent-primary)]" /> Account security
          </h3>
          <button onClick={onClose} className="btn-icon w-7 h-7" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-[var(--radius-md)] bg-[var(--bg-input)] border border-[var(--border-subtle)] text-xs">
          {(['password', 'mfa'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`py-1.5 rounded-[calc(var(--radius-md)-4px)] font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                tab === t ? 'bg-[var(--bg-panel)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t === 'password' ? <KeyRound size={13} /> : <Smartphone size={13} />}
              {t === 'password' ? 'Password' : 'Two-step sign-in'}
            </button>
          ))}
        </div>
        {tab === 'password' ? <PasswordForm /> : <MfaPanel />}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
