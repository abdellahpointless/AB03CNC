import React, { useEffect, useState } from 'react';
import { Crown, ExternalLink } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useT } from '../i18n';
import { MASTER_PATH } from '../lib/instance';

/**
 * Moroccan admins only: creates the very first master admin account (once). Every later master,
 * and the first admin of a new country, is created from the master dashboard.
 */
export default function MasterAccountCard() {
  const { t } = useT('machines');
  const [status, setStatus] = useState<{ available: boolean; exists: boolean } | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ available: boolean; exists: boolean }>('/admin/master-account')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status?.available) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/master-account', { method: 'POST', body: { username: username.trim(), password, currentPassword } });
      setDone(true);
      setStatus({ available: true, exists: true });
      setPassword('');
      setCurrentPassword('');
    } catch (err) {
      setError(errorMessage(err, t('common:errors.generic')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aurora-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-[var(--radius-md)] bg-amber-500/15 border border-amber-500/30 text-amber-500 shrink-0">
          <Crown size={20} />
        </div>
        <div>
          <h3 className="text-lg font-bold text-[var(--text-primary)]">{t('master.title')}</h3>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">{t('master.subtitle')}</p>
        </div>
      </div>
      {status.exists ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="badge-positive text-xs py-1.5 px-3">{done ? t('master.created') : t('master.exists')}</div>
          <a href={MASTER_PATH} className="btn-secondary text-xs py-2 px-4 whitespace-nowrap">
            <ExternalLink size={13} />
            <span>{t('master.open')}</span>
          </a>
        </div>
      ) : (
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="space-y-1">
            <span className="section-label block">{t('master.username')}</span>
            <input className="aurora-input w-full text-xs" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required maxLength={40} />
          </label>
          <label className="space-y-1">
            <span className="section-label block">{t('master.password')}</span>
            <input className="aurora-input w-full text-xs" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={200} required />
          </label>
          <label className="space-y-1">
            <span className="section-label block">{t('master.yourPassword')}</span>
            <input className="aurora-input w-full text-xs" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <button type="submit" disabled={busy} className="btn-primary text-xs py-2 px-4 sm:col-span-3 sm:justify-self-start">
            <Crown size={14} />
            <span>{busy ? t('common:status.working') : t('master.create')}</span>
          </button>
          <p className="sm:col-span-3 text-xs text-[var(--text-tertiary)]">{t('master.passwordHint')}</p>
          {error && <div className="sm:col-span-3 badge-danger text-xs py-1.5 px-3">{error}</div>}
        </form>
      )}
    </div>
  );
}
