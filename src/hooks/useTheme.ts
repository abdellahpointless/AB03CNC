import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
const KEY = 'cnc-theme';

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

const systemLight = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches;

function apply(mode: ThemeMode) {
  const light = mode === 'light' || (mode === 'system' && systemLight());
  const el = document.documentElement;
  el.classList.toggle('dark', !light);
  el.classList.toggle('light', light);
}

/**
 * Colour mode for this PC (dark by default, like before). The choice is a per-device
 * convenience, so it lives in localStorage. index.html applies it before the first paint.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(read);

  useEffect(() => {
    apply(mode);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* optional */
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    // Cross-fade the whole page instead of an abrupt brightness jump.
    if (doc.startViewTransition && !reduce) doc.startViewTransition(() => { apply(next); setModeState(next); });
    else { apply(next); setModeState(next); }
  }, []);

  return { mode, setMode };
}
