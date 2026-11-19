import { useEffect, useState } from 'react';
import { api } from './api';
import { relTurn, setTurnMemory, turnKey } from './setups';
import type { Toolpath } from './toolpath';
import type { Mat3 } from './orient';

/*
 * The turns learned from 3D models (lib/setups.ts, "Turns learned from 3D models"), shared by every
 * country: loaded once per page, and fed with every part whose simulation matched its model.
 */

let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function loadTurnMemory(): Promise<void> {
  loading ??= api<{ rows: { key: string; rel: string; n: number }[] }>('/toolpath/memory')
    .then((r) => {
      setTurnMemory(r.rows);
      version++;
      listeners.forEach((f) => f());
    })
    .catch(() => {
      // Offline or not allowed: the notes are read as before; tried again next time.
      loading = null;
    });
  return loading;
}

/** A number that changes when the memory arrives or grows (to read setups again with it). */
export function useTurnMemory(enabled = true): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    if (!enabled) return;
    const f = () => setV(version);
    listeners.add(f);
    void loadTurnMemory();
    return () => {
      listeners.delete(f);
    };
  }, [enabled]);
  return v;
}

/**
 * Records how each setup of a program really turns (its simulation matched the 3D model with these
 * orientations), then reloads the memory. Best effort.
 */
export function recordTurns(tp: Toolpath, orients: Mat3[]): void {
  const entries = orients
    .slice(1)
    .map((m, i) => ({ key: turnKey(tp.setups[i + 1]?.notes.map((n) => n.text) ?? []), rel: relTurn(m, orients[i]).join() }))
    .filter((e) => e.key);
  if (!entries.length) return;
  void api('/toolpath/memory', { body: { entries } })
    .then(() => {
      loading = null;
      return loadTurnMemory();
    })
    .catch(() => {});
}
