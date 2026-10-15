import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { flushOutbox, getOutboxCount, OUTBOX_EVENT } from '../lib/historyApi';
import type { MachineToolbox, Tool } from '../types';
import { useAuth } from './AuthContext';

/**
 * Keeps every open PC in step with the server. Instead of a realtime socket,
 * each screen asks the Worker for a tiny "versions" record every few seconds
 * and only re-downloads the data that actually changed.
 */

export interface Versions {
  tools: number;
  history: number;
  users: number;
  settings: number;
  parts: number;
}

export interface Analytics {
  savedSecondsPerExtraction: number;
  totalExtractions: number;
  totalTimeSavedSeconds: number;
  contributingUsers: number;
  appSelected: number;
  manualChanged: number;
  users: { username: string; extractions: number; timeSavedSeconds: number; lastExtractedAt: number | null }[];
}

type Connection = 'connecting' | 'online' | 'offline';

interface SyncContextType {
  connection: Connection;
  lastSyncAt: number | null;
  versions: Versions;
  pendingUploads: number;
  toolbox: MachineToolbox;
  toolboxLoaded: boolean;
  analytics: Analytics | null;
  refreshNow: () => Promise<void>;
  saveTool: (machine: string, tool: Tool) => Promise<void>;
  deleteTool: (machine: string, toolId: string) => Promise<void>;
  acknowledgeTool: (machine: string, toolId: string) => void;
  installTools: (machine: string, tools: Tool[]) => Promise<void>;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

// Poll quickly while someone is using the PC, slowly when it sits idle (keeps a shop full of
// always-open screens far below the free plan's 100k requests/day).
const POLL_ACTIVE_MS = 15_000;
const POLL_IDLE_MS = 60_000;
const IDLE_AFTER_MS = 5 * 60_000;
const TOOLBOX_CACHE_KEY = 'cnc-toolbox-cache-v1';
const EMPTY_VERSIONS: Versions = { tools: 0, history: 0, users: 0, settings: 0, parts: 0 };

function readCachedToolbox(): MachineToolbox {
  try {
    const raw = localStorage.getItem(TOOLBOX_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [versions, setVersions] = useState<Versions>(EMPTY_VERSIONS);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [toolbox, setToolbox] = useState<MachineToolbox>(readCachedToolbox);
  const [toolboxLoaded, setToolboxLoaded] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const toolsVersionLoaded = useRef(-1);
  const analyticsKeyLoaded = useRef('');
  const syncing = useRef<Promise<void> | null>(null);

  const loadTools = useCallback(async () => {
    const res = await api<{ toolbox: MachineToolbox; version: number }>('/tools');
    toolsVersionLoaded.current = res.version;
    setToolbox(res.toolbox);
    setToolboxLoaded(true);
    try {
      localStorage.setItem(TOOLBOX_CACHE_KEY, JSON.stringify(res.toolbox));
    } catch {
      /* cache is optional */
    }
  }, []);

  const loadAnalytics = useCallback(async (key: string) => {
    const res = await api<Analytics>('/analytics');
    analyticsKeyLoaded.current = key;
    setAnalytics(res);
  }, []);

  const runSync = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api<{ versions: Versions; serverTime: number }>('/sync', { timeoutMs: 10_000 });
      setVersions(res.versions);
      setConnection('online');
      setLastSyncAt(Date.now());
      const jobs: Promise<unknown>[] = [];
      if (res.versions.tools !== toolsVersionLoaded.current) jobs.push(loadTools());
      const aKey = `${res.versions.history}:${res.versions.settings}`;
      if (aKey !== analyticsKeyLoaded.current) jobs.push(loadAnalytics(aKey));
      jobs.push(flushOutbox());
      await Promise.all(jobs);
    } catch (err) {
      if (err instanceof ApiError && err.offline) setConnection('offline');
      else if (err instanceof ApiError && err.status >= 500) setConnection('offline');
    }
  }, [user, loadTools, loadAnalytics]);

  const refreshNow = useCallback(async () => {
    if (!syncing.current) {
      syncing.current = runSync().finally(() => {
        syncing.current = null;
      });
    }
    return syncing.current;
  }, [runSync]);

  // Poll while the tab is visible; sync immediately when it becomes visible/online again.
  useEffect(() => {
    if (!user) return;
    toolsVersionLoaded.current = -1;
    analyticsKeyLoaded.current = '';
    refreshNow();
    let lastActivity = Date.now();
    let lastPoll = Date.now();
    const onActivity = () => {
      const wasIdle = Date.now() - lastActivity > IDLE_AFTER_MS;
      lastActivity = Date.now();
      if (wasIdle) {
        lastPoll = Date.now();
        refreshNow();
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const interval = Date.now() - lastActivity > IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_ACTIVE_MS;
      if (Date.now() - lastPoll >= interval - 500) {
        lastPoll = Date.now();
        refreshNow();
      }
    }, 5_000);
    const onWake = () => {
      if (document.visibilityState === 'visible') {
        lastActivity = Date.now();
        lastPoll = Date.now();
        refreshNow();
      }
    };
    const activityEvents = ['pointerdown', 'keydown', 'mousemove', 'wheel'] as const;
    activityEvents.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      clearInterval(timer);
      activityEvents.forEach(e => window.removeEventListener(e, onActivity));
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [user, refreshNow]);

  useEffect(() => {
    getOutboxCount().then(setPendingUploads);
    const onChange = (e: Event) => setPendingUploads((e as CustomEvent<number>).detail ?? 0);
    window.addEventListener(OUTBOX_EVENT, onChange);
    return () => window.removeEventListener(OUTBOX_EVENT, onChange);
  }, []);

  // ---- Tool inventory mutations (server first, then refresh) -------------------

  const afterToolWrite = useCallback(async () => {
    await loadTools();
  }, [loadTools]);

  const saveTool = useCallback(
    async (machine: string, tool: Tool) => {
      const { id, ...rest } = tool;
      await api(`/tools/${encodeURIComponent(machine)}/${encodeURIComponent(id)}`, { method: 'PUT', body: rest });
      await afterToolWrite();
    },
    [afterToolWrite],
  );

  const deleteTool = useCallback(
    async (machine: string, toolId: string) => {
      await api(`/tools/${encodeURIComponent(machine)}/${encodeURIComponent(toolId)}`, { method: 'DELETE' });
      await afterToolWrite();
    },
    [afterToolWrite],
  );

  const acknowledgeTool = useCallback(
    (machine: string, toolId: string) => {
      // Optimistic: clear the orange marker instantly, then tell the server.
      setToolbox((prev) => ({
        ...prev,
        [machine]: (prev[machine as keyof MachineToolbox] || []).map((t) => (t.id === toolId ? { ...t, changed: false } : t)),
      }));
      api(`/tools/${encodeURIComponent(machine)}/${encodeURIComponent(toolId)}/ack`, { method: 'POST' }).catch(() => {});
    },
    [],
  );

  const installTools = useCallback(
    async (machine: string, tools: Tool[]) => {
      await api(`/tools/${encodeURIComponent(machine)}/batch`, { method: 'POST', body: { tools } });
      await afterToolWrite();
    },
    [afterToolWrite],
  );

  return (
    <SyncContext.Provider
      value={{
        connection,
        lastSyncAt,
        versions,
        pendingUploads,
        toolbox,
        toolboxLoaded,
        analytics,
        refreshNow,
        saveTool,
        deleteTool,
        acknowledgeTool,
        installTools,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within a SyncProvider');
  return ctx;
}
