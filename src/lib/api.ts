import { apiBase } from './instance';
import i18n from '../i18n';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any = null,
  ) {
    super(message);
  }
  /** True when the server could not be reached at all (offline, DNS, timeout). */
  get offline(): boolean {
    return this.status === 0;
  }
}

export const SESSION_EXPIRED_EVENT = 'cnc-session-expired';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Another API base (e.g. the master hub from a country page). */
  base?: string;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener('abort', () => controller.abort());

  let res: Response;
  try {
    res = await fetch(`${opts.base ?? apiBase()}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'X-CNC-Client': '1' } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(i18n.t('common:errors.offline'), 0);
  } finally {
    clearTimeout(timeout);
  }

  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(data?.error || i18n.t('common:errors.requestFailed', { status: res.status }), res.status, data);
  }
  return data as T;
}

export function errorMessage(err: unknown, fallback = i18n.t('common:errors.generic')): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
