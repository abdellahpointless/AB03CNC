import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { motion } from 'motion/react';
import { EXIT_FAST, FADE, SPRING_MODAL } from '../lib/motion';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return createPortal(
    <motion.div
      className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: EXIT_FAST }}
      transition={FADE}
    >
      <motion.div
        className="glass-modal max-w-sm w-full p-6"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8, transition: EXIT_FAST }}
        transition={SPRING_MODAL}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
            <KeyRound size={16} className="text-[var(--accent-primary)]" /> Change your password
          </h3>
          <button onClick={onClose} className="btn-icon w-7 h-7" title="Close">
            <X size={14} />
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <div className="badge-positive w-full py-2 px-3 text-xs">Password changed. Other PCs using this account were signed out.</div>
            <button onClick={onClose} className="btn-primary w-full text-xs py-2">Close</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input type="password" className="aurora-input w-full text-xs" placeholder="Current password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
            <input type="password" className="aurora-input w-full text-xs" placeholder="New password (8+ characters recommended)" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" minLength={4} required />
            <input type="password" className="aurora-input w-full text-xs" placeholder="Repeat new password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
            {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
            <button type="submit" disabled={busy} className="btn-primary w-full text-xs py-2">{busy ? 'Saving...' : 'Change password'}</button>
          </form>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
