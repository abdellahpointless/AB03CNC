import React, { useEffect, useState } from 'react';
import { useAuth, Role } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { api } from '../lib/api';
import { UserPlus, Trash2, Shield, User as UserIcon, KeyRound, RefreshCw, ShieldCheck, ShieldOff, ScrollText } from 'lucide-react';
import { motion } from 'motion/react';
import { waveItem } from '../lib/motion';
import { useT } from '../i18n';
import { fmtDateTime } from '../i18n/format';

interface AccountRow {
  id: string;
  username: string;
  role: Role;
  created_at: number;
  mfa_enabled?: number;
}

interface AuditEvent {
  id: number;
  at: number;
  username: string | null;
  ip: string | null;
  action: string;
  detail: string | null;
}

/** Security log action (as recorded by the server) -> its label under `users.log.actions`. */
const ACTION_LABELS = {
  login: 'login',
  login_failed: 'loginFailed',
  mfa_failed: 'mfaFailed',
  password_check_failed: 'passwordCheckFailed',
  password_changed: 'passwordChanged',
  mfa_enabled: 'mfaEnabled',
  mfa_disabled: 'mfaDisabled',
  user_created: 'userCreated',
  user_updated: 'userUpdated',
  user_deleted: 'userDeleted',
  admin_action: 'adminAction',
  admin_denied: 'adminDenied',
  setup: 'setup',
} as const;
type ActionLabel = (typeof ACTION_LABELS)[keyof typeof ACTION_LABELS];
const ALERT_ACTIONS = new Set(['login_failed', 'mfa_failed', 'password_check_failed', 'admin_denied']);

/** Latest security events (sign-ins, failures, account changes). Admin only. */
function SecurityLog() {
  const { t } = useT('app');
  const actionLabel = (action: string) => {
    const key = (ACTION_LABELS as Record<string, ActionLabel | undefined>)[action];
    return key ? t(`users.log.actions.${key}`) : action;
  };
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api<{ events: AuditEvent[] }>('/admin/audit')
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e?.message || t('users.log.loadFailed')));
  };
  useEffect(() => {
    if (open && !events) load();
  }, [open]);
  return (
    <div className="aurora-card p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="no-glass w-full p-4 flex items-center justify-between text-left hover:bg-[rgba(var(--ov),0.03)] transition-colors"
      >
        <span className="section-label flex items-center gap-2"><ScrollText size={14} /> {t('users.log.title')}</span>
        <span className="text-xs text-[var(--text-tertiary)]">{open ? t('users.log.hide') : t('users.log.show')}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border-subtle)]">
          {error && <div className="badge-danger text-xs py-1.5 px-3 m-3">{error}</div>}
          {!events && !error && (
            <div className="p-6 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
              <RefreshCw size={14} className="animate-spin" /> {t('common:status.loading')}
            </div>
          )}
          {events && (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-[var(--bg-panel)]">
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="p-2.5 section-label">{t('users.log.colWhen')}</th>
                    <th className="p-2.5 section-label">{t('users.log.colWho')}</th>
                    <th className="p-2.5 section-label">{t('users.log.colWhat')}</th>
                    <th className="p-2.5 section-label">{t('users.log.colIp')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-[var(--text-tertiary)]">{t('users.log.empty')}</td></tr>
                  )}
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--border-subtle)] last:border-0">
                      <td className="p-2.5 whitespace-nowrap font-mono text-xs text-[var(--text-secondary)]">{fmtDateTime(e.at)}</td>
                      <td className="p-2.5 font-semibold text-[var(--text-primary)]">{e.username ?? '-'}</td>
                      <td className={`p-2.5 ${ALERT_ACTIONS.has(e.action) ? 'text-[var(--rose-500)]' : 'text-[var(--text-primary)]'}`}>
                        {actionLabel(e.action)}
                        {e.detail && <span className="text-[var(--text-tertiary)]"> &middot; {e.detail}</span>}
                      </td>
                      <td className="p-2.5 font-mono text-xs text-[var(--text-tertiary)]">{e.ip ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="p-3 border-t border-[var(--border-subtle)] flex justify-end">
            <button type="button" onClick={load} className="btn-secondary text-xs py-1 px-3"><RefreshCw size={12} /> <span>{t('common:actions.refresh')}</span></button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UserManagement() {
  const { t } = useT('app');
  const { user } = useAuth();
  const { versions } = useSync();
  const [users, setUsers] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('MACHINIST');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    let cancelled = false;
    api<{ users: AccountRow[] }>('/users')
      .then(res => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || t('users.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.role, versions.users, reloadKey]);

  if (user?.role !== 'ADMIN') {
    return (
      <div className="p-12 text-center text-[var(--text-tertiary)] glass-panel max-w-md mx-auto my-12">
        <Shield size={36} className="mx-auto mb-2 text-[var(--rose-500)] opacity-60" />
        <p className="text-sm font-semibold text-[var(--text-primary)]">{t('users.accessRestricted')}</p>
        <p className="text-xs text-[var(--text-secondary)] mt-1">{t('users.noPermission')}</p>
      </div>
    );
  }

  const run = async (id: string | null, fn: () => Promise<unknown>, okMessage: string) => {
    setError('');
    setNotice('');
    setBusyId(id ?? 'new');
    try {
      await fn();
      setNotice(okMessage);
      setReloadKey(k => k + 1);
      return true;
    } catch (err: any) {
      setError(err?.message || t('users.requestFailed'));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = newUsername.trim();
    const ok = await run(
      null,
      () => api('/users', { method: 'POST', body: { username, password: newPassword, role: newRole } }),
      t('users.created', { name: username }),
    );
    if (ok) {
      setNewUsername('');
      setNewPassword('');
      setNewRole('MACHINIST');
    }
  };

  const handleDelete = (u: AccountRow) => {
    if (!confirm(t('users.confirmDelete', { name: u.username }))) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' }), t('users.deleted', { name: u.username }));
  };

  const handleResetPassword = (u: AccountRow) => {
    const pw = prompt(t('users.promptPassword', { name: u.username, min: u.role === 'ADMIN' ? 10 : 8 }));
    if (pw === null) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { password: pw } }), t('users.passwordReset', { name: u.username }));
  };

  const handleResetMfa = (u: AccountRow) => {
    if (!confirm(t('users.confirmResetMfa', { name: u.username }))) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { resetMfa: true } }), t('users.mfaReset', { name: u.username }));
  };

  const handleRoleChange = (u: AccountRow, role: Role) => {
    if (role === u.role) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { role } }), role === 'ADMIN' ? t('users.nowAdmin', { name: u.username }) : t('users.nowMachinist', { name: u.username }));
  };

  return (
    <div className="space-y-5 pb-12 w-full">
      {/* Header Glass Panel */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-text)]">
              <Shield size={20} />
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('users.title')}
            </h2>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 pl-1">
            {t('users.subtitle')}
          </p>
        </div>
      </div>

      {/* Add New User Card */}
      <div className="aurora-card p-5">
        <h3 className="section-label mb-4 text-[var(--text-primary)]">{t('users.addTitle')}</h3>
        <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex-1 space-y-1 w-full sm:w-auto">
            <label className="section-label block">{t('users.username')}</label>
            <input
              type="text"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              className="aurora-input w-full text-xs"
              placeholder={t('users.usernamePlaceholder')}
              autoComplete="off"
              required
            />
          </div>
          <div className="flex-1 space-y-1 w-full sm:w-auto">
            <label className="section-label block">{t('users.password')}</label>
            <input
              type="text"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="aurora-input w-full text-xs"
              placeholder={t('users.passwordPlaceholder', { min: newRole === 'ADMIN' ? 10 : 8 })}
              autoComplete="off"
              minLength={newRole === 'ADMIN' ? 10 : 8}
              maxLength={200}
              required
            />
          </div>
          <div className="w-full sm:w-36 space-y-1">
            <label className="section-label block">{t('users.role')}</label>
            <select
              aria-label={t('users.role')}
              value={newRole}
              onChange={e => setNewRole(e.target.value as Role)}
              className="aurora-input w-full text-xs cursor-pointer"
            >
              <option value="MACHINIST" className="bg-[var(--bg-panel)]">{t('common:role.MACHINIST')}</option>
              <option value="ADMIN" className="bg-[var(--bg-panel)]">{t('common:role.ADMIN')}</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={busyId !== null}
            className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 whitespace-nowrap self-stretch sm:self-end"
          >
            <UserPlus size={15} />
            <span>{t('users.addAccount')}</span>
          </button>
        </form>
        {error && <div className="badge-danger text-xs py-1.5 px-3 mt-3 font-semibold">{error}</div>}
        {notice && <div className="badge-positive text-xs py-1.5 px-3 mt-3">{notice}</div>}
      </div>

      {/* User Accounts List Table */}
      <div className="aurora-card p-0 overflow-hidden">
        <div className="p-4 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.5)] flex items-center justify-between">
          <span className="section-label">{t('users.registered')}</span>
          <span className="badge-neutral text-xs py-0 px-2 font-mono">{t('users.userCount', { n: users.length })}</span>
        </div>
        {loading && users.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" /> {t('users.loadingAccounts')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
                  <th className="p-3.5 section-label">{t('users.colUser')}</th>
                  <th className="p-3.5 section-label">{t('users.colRole')}</th>
                  <th className="p-3.5 section-label text-right">{t('users.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <motion.tr
                    {...waveItem(idx)}
                    key={u.id}
                    className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[rgba(var(--ov),0.02)] transition-colors"
                  >
                    <td className="p-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[var(--bg-input)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-tertiary)]">
                          <UserIcon size={14} />
                        </div>
                        <span className="font-semibold text-xs text-[var(--text-primary)]">{u.username}</span>
                        {u.id === user?.id && <span className="badge-neutral text-xs py-0 px-1.5">{t('users.you')}</span>}
                        {!!u.mfa_enabled && (
                          <span className="badge-positive text-xs py-0 px-1.5 inline-flex items-center gap-1" title={t('users.mfaOnTitle')}>
                            <ShieldCheck size={10} /> {t('users.twoStep')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3.5">
                      <select
                        aria-label={t('common:a11y.roleOf', { user: u.username })}
                        value={u.role}
                        disabled={busyId !== null || u.id === user?.id}
                        onChange={e => handleRoleChange(u, e.target.value as Role)}
                        className={`text-xs px-2.5 py-1 rounded-[var(--radius-full)] font-mono font-bold cursor-pointer ${
                          u.role === 'ADMIN' ? 'badge-warning' : 'badge-positive'
                        }`}
                        title={u.id === user?.id ? t('users.ownRoleTitle') : t('users.changeRoleTitle')}
                      >
                        <option value="MACHINIST" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">{t('users.roleUpper.MACHINIST')}</option>
                        <option value="ADMIN" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">{t('users.roleUpper.ADMIN')}</option>
                      </select>
                    </td>
                    <td className="p-3.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {u.id !== user?.id && !!u.mfa_enabled && (
                          <button
                            onClick={() => handleResetMfa(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 inline-flex"
                            title={t('users.resetMfaTitle')}
                          >
                            <ShieldOff size={14} />
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            onClick={() => handleResetPassword(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 inline-flex"
                            title={t('users.setPasswordTitle')}
                          >
                            <KeyRound size={14} />
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            onClick={() => handleDelete(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 hover:text-[var(--rose-500)] hover:bg-[rgba(255,102,121,0.1)] inline-flex"
                            title={t('users.deleteTitle')}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SecurityLog />
    </div>
  );
}
