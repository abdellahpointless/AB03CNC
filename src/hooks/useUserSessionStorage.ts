import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Working state that belongs to one operator on one PC (the program they are
 * editing, the selected machine...). It is kept in this browser only - never
 * shared with other PCs - and saved with a short debounce so typing in a large
 * program stays smooth.
 */
export function useUserSessionStorage<T>(userIdentifier: string, key: string, initialValue: T) {
  const scopedKey = `cnc-session-${userIdentifier || 'guest'}-${key}`;
  const initialRef = useRef(initialValue);

  const read = useCallback((k: string): T => {
    try {
      const raw = window.localStorage.getItem(k) ?? window.sessionStorage.getItem(k);
      if (raw === null) return initialRef.current;
      const parsed = JSON.parse(raw);
      if (typeof initialRef.current === 'string') {
        if (typeof parsed === 'string') return parsed as T;
        if (parsed && typeof parsed.code === 'string') return parsed.code as T;
        if (parsed && typeof parsed.value === 'string') return parsed.value as T;
        return initialRef.current;
      }
      return (parsed ?? initialRef.current) as T;
    } catch {
      return initialRef.current;
    }
  }, []);

  const [value, setValueState] = useState<T>(() => read(scopedKey));
  const valueRef = useRef(value);
  const keyRef = useRef(scopedKey);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((k: string, v: T) => {
    try {
      window.localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // Very large programs can exceed the browser quota; keep them in memory only.
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      persist(keyRef.current, valueRef.current);
    }
  }, [persist]);

  // Switch to the new user's data when the signed-in user changes.
  useEffect(() => {
    if (keyRef.current !== scopedKey) {
      flush();
      keyRef.current = scopedKey;
      const next = read(scopedKey);
      valueRef.current = next;
      setValueState(next);
    }
  }, [scopedKey, flush, read]);

  useEffect(() => {
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [flush]);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved = next instanceof Function ? next(valueRef.current) : next;
      valueRef.current = resolved;
      setValueState(resolved);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        persist(keyRef.current, valueRef.current);
      }, 400);
    },
    [persist],
  );

  return [value, setValue] as const;
}
