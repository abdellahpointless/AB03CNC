export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function readJson<T = any>(request: Request, maxBytes = 25 * 1024 * 1024): Promise<T> {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'Request body too large');
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// ---- Small validation helpers -------------------------------------------------

export function str(v: unknown, field: string, { max = 500, min = 0, trim = true } = {}): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const s = trim ? v.trim() : v;
  if (s.length < min) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
}

export function optStr(v: unknown, field: string, max = 500): string | null {
  if (v === undefined || v === null || v === '') return null;
  return str(v, field, { max });
}

export function num(v: unknown, field: string, { min = -Infinity, max = Infinity, integer = false } = {}): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  if (integer && !Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number`);
  if (n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  return n;
}

export function optNum(v: unknown, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === '') return null;
  return num(v, field, opts);
}

export function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
  return Math.min(max, Math.max(min, n));
}
