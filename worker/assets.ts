import { getSessionUser } from './auth';
import type { Env } from './context';
import { readFeatures } from './features';
import { getCookie } from './http';
import { MASTER, REGIONS, type RegionId } from '../src/regions';

/*
 * The app's code is not public. Only the country picker and the sign-in page are served to
 * everyone (dist/assets/); the rest of the build is in dist/app/<access>/ (see
 * vite-private-chunks.ts), and this hands a file there out only to a browser signed in with
 * that access. Without it, anyone with the link could download the whole app and copy it.
 *
 *   user      signed in to a country
 *   admin     a country admin
 *   toolpath  the toolpath viewer: an admin, or the toolpath beta or CAM AI, with the toolpath on in that country
 *   cam       CAM AI and the shop's cutting data: an admin or CAM AI, with the toolpath on in that country
 *   master    a master admin
 *   any       signed in to a country or the master dashboard
 *
 * The files are the same for every country, so a session of any country (or the master hub,
 * where allowed) opens them. Whatever a signed-in browser receives, its user can still save:
 * this keeps the app away from people without an account, not from the people who use it.
 */

const PRIVATE_FILE = /^\/app\/(user|admin|toolpath|cam|master|any)\/[A-Za-z0-9._-]+\.(js|css|wasm)$/;

type Tier = 'user' | 'admin' | 'toolpath' | 'cam' | 'master' | 'any';
type Instance = RegionId | 'master';

export function isPrivateAssetPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

function notFound(status = 404): Response {
  return new Response(status === 404 ? 'Not found' : 'Sign in to open the app', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function hasSessionCookie(request: Request, instance: Instance): boolean {
  if (instance === 'master') return !!getCookie(request, MASTER.sessionCookie);
  const region = REGIONS.find((r) => r.id === instance)!;
  return !!getCookie(request, region.sessionCookie) || (!!region.legacyCookie && !!getCookie(request, region.legacyCookie));
}

/** Whether the session of this instance may open files of this tier (and cookies to pass on). */
async function allowed(env: Env, request: Request, instance: Instance, tier: Tier): Promise<{ ok: boolean; setCookies: string[] }> {
  if (instance === 'master' ? tier !== 'master' && tier !== 'any' : tier === 'master') return { ok: false, setCookies: [] };
  if (!hasSessionCookie(request, instance)) return { ok: false, setCookies: [] };
  let session: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    session = await getSessionUser(env, request);
  } catch {
    return { ok: false, setCookies: [] }; // a database that is not set up has no sessions
  }
  if (!session) return { ok: false, setCookies: [] };
  const { user, setCookies } = session;
  if (instance === 'master' || tier === 'user' || tier === 'any') return { ok: true, setCookies };
  if (tier === 'admin') return { ok: user.role === 'ADMIN', setCookies };
  const entitled = user.role === 'ADMIN' || !!user.camAi || (tier === 'toolpath' && !!user.toolpathBeta);
  if (!entitled) return { ok: false, setCookies };
  const features = await readFeatures(env.DB, instance);
  return { ok: features.toolpath, setCookies };
}

/**
 * Serves /app/... to a signed-in browser with the right access, and nothing to anyone else.
 * `envFor` gives the environment of one instance (its own database), as the API router does.
 */
export async function handlePrivateAsset(request: Request, env: Env, url: URL, envFor: (instance: Instance) => Env | null): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(405);
  const m = url.pathname.match(PRIVATE_FILE);
  if (!m) return notFound();
  const tier = m[1] as Tier;

  let ok = false;
  const setCookies: string[] = [];
  for (const instance of [...REGIONS.map((r) => r.id), 'master'] as Instance[]) {
    const scoped = envFor(instance);
    if (!scoped) continue;
    const r = await allowed(scoped, request, instance, tier);
    setCookies.push(...r.setCookies);
    if (r.ok) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    const res = notFound(403);
    for (const c of setCookies) res.headers.append('Set-Cookie', c);
    return res;
  }

  const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method, headers: { Accept: request.headers.get('Accept') ?? '*/*' } }));
  // A file that does not exist comes back as the app's index.html (single-page fallback): refuse it.
  const type = asset.headers.get('Content-Type') ?? '';
  if (!asset.ok || !/javascript|css|wasm/i.test(type)) return notFound();

  const res = new Response(asset.body, asset);
  // The browser may keep it (file names change with every build), shared caches may not.
  res.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.headers.set('Vary', 'Cookie');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  for (const c of setCookies) res.headers.append('Set-Cookie', c);
  return res;
}
