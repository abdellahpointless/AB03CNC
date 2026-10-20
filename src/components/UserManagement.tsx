import React, { useEffect, useState } from 'react';
import { useAuth, Role } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { api } from '../lib/api';
import { UserPlus, Trash2, Shield, User as UserIcon, KeyRound, RefreshCw, ShieldCheck, ShieldOff, ScrollText } from 'lucide-react';
import { motion } from 'motion/react';
import { waveItem } from '../lib/motion';

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

const ACTION_LABELS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Wrong password',
  mfa_failed: 'Wrong 2-step code',
  password_check_failed: 'Wrong current password',
  password_changed: 'Changed own password',
  mfa_enabled: 'Turned on 2-step sign-in',
  mfa_disabled: 'Turned off 2-step sign-in',
  user_created: 'Created account',
  user_updated: 'Changed account',
  user_deleted: 'Deleted account',
  admin_action: 'Admin change',
  admin_denied: 'Blocked admin request',
  setup: 'First setup',
};
const ALERT_ACTIONS = new Set(['login_failed', 'mfa_failed', 'password_check_failed', 'admin_denied']);

/** Latest security events (sign-ins, failures, account changes). Admin only. */
function SecurityLog() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api<{ events: AuditEvent[] }>('/admin/audit')
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e?.message || 'Could not load the security log'));
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
        <span className="section-label flex items-center gap-2"><ScrollText size={14} /> Security log</span>
        <span className="text-[11px] text-[var(--text-tertiary)]">{open ? 'Hide' : 'Show sign-ins and account changes'}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border-subtle)]">
          {error && <div className="badge-danger text-xs py-1.5 px-3 m-3">{error}</div>}
          {!events && !error && (
            <div className="p-6 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
              <RefreshCw size={14} className="animate-spin" /> Loading...
            </div>
          )}
          {events && (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-[var(--bg-panel)]">
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="p-2.5 section-label">When</th>
                    <th className="p-2.5 section-label">Who</th>
                    <th className="p-2.5 section-label">What</th>
                    <th className="p-2.5 section-label">IP address</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-[var(--text-tertiary)]">No events yet.</td></tr>
                  )}
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--border-subtle)] last:border-0">
                      <td className="p-2.5 whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]">{new Date(e.at).toLocaleString('en-GB')}</td>
                      <td className="p-2.5 font-semibold text-[var(--text-primary)]">{e.username ?? '-'}</td>
                      <td className={`p-2.5 ${ALERT_ACTIONS.has(e.action) ? 'text-[var(--rose-500)]' : 'text-[var(--text-primary)]'}`}>
                        {ACTION_LABELS[e.action] ?? e.action}
                        {e.detail && <span className="text-[var(--text-tertiary)]"> &middot; {e.detail}</span>}
                      </td>
                      <td className="p-2.5 font-mono text-[11px] text-[var(--text-tertiary)]">{e.ip ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="p-3 border-t border-[var(--border-subtle)] flex justify-end">
            <button type="button" onClick={load} className="btn-secondary text-xs py-1 px-3"><RefreshCw size={12} /> <span>Refresh</span></button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UserManagement() {
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
        if (!cancelled) setError(err?.message || 'Could not load accounts');
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
        <p className="text-sm font-semibold text-[var(--text-primary)]">Access Restricted</p>
        <p className="text-xs text-[var(--text-secondary)] mt-1">You do not have permission to view operator account administration.</p>
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
      setError(err?.message || 'Request failed');
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
      `Account "${username}" created.`,
    );
    if (ok) {
      setNewUsername('');
      setNewPassword('');
      setNewRole('MACHINIST');
    }
  };

  const handleDelete = (u: AccountRow) => {
    if (!confirm(`Delete the account "${u.username}"? Their history and part entries are kept.`)) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' }), `Account "${u.username}" deleted.`);
  };

  const handleResetPassword = (u: AccountRow) => {
    const pw = prompt(`New password for "${u.username}" (at least ${u.role === 'ADMIN' ? 10 : 8} characters):`);
    if (pw === null) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { password: pw } }), `Password for "${u.username}" changed. They are signed out on other PCs.`);
  };

  const handleResetMfa = (u: AccountRow) => {
    if (!confirm(`Turn off two-step sign-in for "${u.username}"? Use this when they lost their phone. They can turn it on again after signing in.`)) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { resetMfa: true } }), `Two-step sign-in reset for "${u.username}".`);
  };

  const handleRoleChange = (u: AccountRow, role: Role) => {
    if (role === u.role) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { role } }), `"${u.username}" is now ${role}.`);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-12 w-full">
      {/* Header Glass Panel */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)]">
              <Shield size={20} />
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              User &amp; Operator Management
            </h2>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 pl-1">
            Provision machinist and administrator accounts across the shop floor. Passwords are stored as salted hashes; every sign-in and account change is logged below.
          </p>
        </div>
      </div>

      {/* Add New User Card */}
      <div className="aurora-card p-5">
        <h3 className="section-label mb-4 text-[var(--text-primary)]">Add New Account</h3>
        <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex-1 space-y-1 w-full sm:w-auto">
            <label className="section-label block">Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              className="aurora-input w-full text-xs"
              placeholder="e.g. machinist_1"
              autoComplete="off"
              required
            />
          </div>
          <div className="flex-1 space-y-1 w-full sm:w-auto">
            <label className="section-label block">Password</label>
            <input
              type="text"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="aurora-input w-full text-xs"
              placeholder={newRole === 'ADMIN' ? 'at least 10 characters' : 'at least 8 characters'}
              autoComplete="off"
              minLength={newRole === 'ADMIN' ? 10 : 8}
              maxLength={200}
              required
            />
          </div>
          <div className="w-full sm:w-36 space-y-1">
            <label className="section-label block">Role</label>
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value as Role)}
              className="aurora-input w-full text-xs cursor-pointer"
            >
              <option value="MACHINIST" className="bg-[var(--bg-panel)]">Machinist</option>
              <option value="ADMIN" className="bg-[var(--bg-panel)]">Admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={busyId !== null}
            className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 whitespace-nowrap self-stretch sm:self-end"
          >
            <UserPlus size={15} />
            <span>Add Account</span>
          </button>
        </form>
        {error && <div className="badge-danger text-xs py-1.5 px-3 mt-3 font-semibold">{error}</div>}
        {notice && <div className="badge-positive text-xs py-1.5 px-3 mt-3">{notice}</div>}
      </div>

      {/* User Accounts List Table */}
      <div className="aurora-card p-0 overflow-hidden">
        <div className="p-4 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.5)] flex items-center justify-between">
          <span className="section-label">Registered Accounts</span>
          <span className="badge-neutral text-[10px] py-0 px-2 font-mono">{users.length} users</span>
        </div>
        {loading && users.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" /> Loading accounts...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
                  <th className="p-3.5 section-label">User</th>
                  <th className="p-3.5 section-label">Role</th>
                  <th className="p-3.5 section-label text-right">Actions</th>
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
                        {u.id === user?.id && <span className="badge-neutral text-[9px] py-0 px-1.5">you</span>}
                        {!!u.mfa_enabled && (
                          <span className="badge-positive text-[9px] py-0 px-1.5 inline-flex items-center gap-1" title="Two-step sign-in is on">
                            <ShieldCheck size={10} /> 2-step
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3.5">
                      <select
                        value={u.role}
                        disabled={busyId !== null || u.id === user?.id}
                        onChange={e => handleRoleChange(u, e.target.value as Role)}
                        className={`text-[10px] px-2.5 py-1 rounded-[var(--radius-full)] font-mono font-bold cursor-pointer ${
                          u.role === 'ADMIN' ? 'badge-warning' : 'badge-positive'
                        }`}
                        title={u.id === user?.id ? 'You cannot change your own role' : 'Change role'}
                      >
                        <option value="MACHINIST" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">MACHINIST</option>
                        <option value="ADMIN" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">ADMIN</option>
                      </select>
                    </td>
                    <td className="p-3.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {u.id !== user?.id && !!u.mfa_enabled && (
                          <button
                            onClick={() => handleResetMfa(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 inline-flex"
                            title="Reset two-step sign-in (lost phone)"
                          >
                            <ShieldOff size={14} />
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            onClick={() => handleResetPassword(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 inline-flex"
                            title="Set a new password"
                          >
                            <KeyRound size={14} />
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            onClick={() => handleDelete(u)}
                            disabled={busyId !== null}
                            className="btn-icon w-8 h-8 hover:text-[var(--rose-500)] hover:bg-[rgba(255,102,121,0.1)] inline-flex"
                            title="Delete User"
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
