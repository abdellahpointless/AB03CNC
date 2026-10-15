import React, { useEffect, useState } from 'react';
import { useAuth, Role } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { api } from '../lib/api';
import { UserPlus, Trash2, Shield, User as UserIcon, KeyRound, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';

interface AccountRow {
  id: string;
  username: string;
  role: Role;
  created_at: number;
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
    const pw = prompt(`New password for "${u.username}" (at least 4 characters):`);
    if (pw === null) return;
    run(u.id, () => api(`/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { password: pw } }), `Password for "${u.username}" changed. They are signed out on other PCs.`);
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
            Provision machinist and administrator accounts across the shop floor. Passwords are stored encrypted (hashed).
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
              placeholder="at least 4 characters"
              autoComplete="new-password"
              minLength={4}
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
        <div className="p-4 border-b border-[var(--border-subtle)] bg-[rgba(15,20,30,0.5)] flex items-center justify-between">
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
                <tr className="border-b border-[var(--border-subtle)] bg-[rgba(255,255,255,0.02)]">
                  <th className="p-3.5 section-label">User</th>
                  <th className="p-3.5 section-label">Role</th>
                  <th className="p-3.5 section-label text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <motion.tr
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(idx, 10) * 0.03 }}
                    key={u.id}
                    className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                  >
                    <td className="p-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[var(--bg-input)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-tertiary)]">
                          <UserIcon size={14} />
                        </div>
                        <span className="font-semibold text-xs text-[var(--text-primary)]">{u.username}</span>
                        {u.id === user?.id && <span className="badge-neutral text-[9px] py-0 px-1.5">you</span>}
                      </div>
                    </td>
                    <td className="p-3.5">
                      <select
                        value={u.role}
                        disabled={busyId !== null}
                        onChange={e => handleRoleChange(u, e.target.value as Role)}
                        className={`text-[10px] px-2.5 py-1 rounded-[var(--radius-full)] font-mono font-bold cursor-pointer ${
                          u.role === 'ADMIN' ? 'badge-warning' : 'badge-positive'
                        }`}
                        title="Change role"
                      >
                        <option value="MACHINIST" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">MACHINIST</option>
                        <option value="ADMIN" className="bg-[var(--bg-panel)] text-[var(--text-primary)]">ADMIN</option>
                      </select>
                    </td>
                    <td className="p-3.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => handleResetPassword(u)}
                          disabled={busyId !== null}
                          className="btn-icon w-8 h-8 inline-flex"
                          title="Set a new password"
                        >
                          <KeyRound size={14} />
                        </button>
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
    </div>
  );
}
