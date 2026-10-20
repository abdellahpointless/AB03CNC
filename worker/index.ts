import { HttpError, json } from './http';
import { ensureSchema } from './schema';
import type { Ctx, Env } from './context';
import {
  getSessionUser,
  handleAuditLog,
  handleChangeOwnPassword,
  handleLogin,
  handleLogout,
  handleMe,
  handleMfaDisable,
  handleMfaEnable,
  handleMfaSetup,
  handleMfaVerify,
  handleSetup,
} from './auth';
import { audit } from './security';
import { translateMessage } from './i18n';
import './i18n-tr';
import { readFeatures } from './features';
import { REGIONS, featureOfApiPath, regionById, type RegionId } from '../src/regions';
import { handleCreateMachine, handleGetFeatures, handleListFleet, handleRemoveMachine, handleUpdateMachine } from './routes/fleet';
import {
  handleCountryAdmins,
  handleSetCountryFeatures,
  handleCreateCountryAdmin,
  handleCreateFirstMaster,
  handleCreateMaster,
  handleDeleteMaster,
  handleListMasters,
  handleMasterAccountStatus,
  handleMasterOverview,
} from './routes/master';
import { handleAckTool, handleBatchTools, handleDeleteTool, handleGetTools, handlePutTool } from './routes/tools';
import {
  handleClearHistory,
  handleCreateHistory,
  handleGetCode,
  handleHistorySince,
  handleHistoryUsers,
  handleListHistory,
  handlePruneHistory,
} from './routes/history';
import { handleCreateUser, handleDeleteUser, handleListUsers, handleUpdateUser } from './routes/users';
import { handleAnalytics, handleSetSavedSeconds, handleSync } from './routes/analytics';
import {
  handleAdminExport,
  handleAdminSummary,
  handleMyExport,
  handleMyMonthEntries,
  handleMySummary,
  handlePending,
  handleReview,
  handleSubmitPart,
} from './routes/parts';
import {
  handleCheckAction,
  handleCreateCheck,
  handleDeleteCheck,
  handleListMachines,
  handleReportIssue,
  handleSetOwners,
  handleUpdateCheck,
} from './routes/machines';
import {
  handleImportCode,
  handleImportHistory,
  handleImportParts,
  handleImportSettings,
  handleImportTools,
  handleImportToolsExcel,
  handleImportUsers,
} from './routes/admin';

type Access = 'public' | 'optional' | 'user' | 'admin';
type Handler = (ctx: Ctx) => Promise<Response>;

type Route = { method: string; pattern: URLPattern; access: Access; handler: Handler };

/** Routes of a country app (each country runs the same app on its own database). */
const routes: Route[] = [];
/** Routes of the master hub. Nothing of the country app is reachable here. */
const masterRoutes: Route[] = [];

function route(method: string, path: string, access: Access, handler: Handler) {
  routes.push({ method, pattern: new URLPattern({ pathname: `/api${path}` }), access, handler });
}
function masterRoute(method: string, path: string, access: Access, handler: Handler) {
  masterRoutes.push({ method, pattern: new URLPattern({ pathname: `/api${path}` }), access, handler });
}

// Auth
route('GET', '/auth/me', 'optional', handleMe);
route('POST', '/auth/login', 'public', handleLogin);
route('POST', '/auth/logout', 'public', handleLogout);
route('POST', '/auth/setup', 'public', handleSetup);
route('POST', '/auth/password', 'user', handleChangeOwnPassword);
route('POST', '/auth/mfa/verify', 'public', handleMfaVerify);
route('POST', '/auth/mfa/setup', 'user', handleMfaSetup);
route('POST', '/auth/mfa/enable', 'user', handleMfaEnable);
route('POST', '/auth/mfa/disable', 'user', handleMfaDisable);
route('GET', '/admin/audit', 'admin', handleAuditLog);

// Sync + analytics
route('GET', '/sync', 'user', handleSync);
route('GET', '/analytics', 'user', handleAnalytics);
route('PUT', '/settings/saved-seconds', 'admin', handleSetSavedSeconds);

// Tool inventory (shared by all operators, like before)
route('GET', '/tools', 'user', handleGetTools);
route('POST', '/tools/:machine/batch', 'user', handleBatchTools);
route('POST', '/tools/:machine/:id/ack', 'user', handleAckTool);
route('PUT', '/tools/:machine/:id', 'user', handlePutTool);
route('DELETE', '/tools/:machine/:id', 'user', handleDeleteTool);

// History + program files
route('GET', '/history', 'user', handleListHistory);
route('POST', '/history', 'user', handleCreateHistory);
route('DELETE', '/history', 'admin', handleClearHistory);
route('GET', '/history/users', 'admin', handleHistoryUsers);
route('GET', '/history/since', 'admin', handleHistorySince);
route('POST', '/history/prune', 'admin', handlePruneHistory);
route('GET', '/history/:id/code', 'user', handleGetCode);

// Users
route('GET', '/users', 'admin', handleListUsers);
route('POST', '/users', 'admin', handleCreateUser);
route('PATCH', '/users/:id', 'admin', handleUpdateUser);
route('DELETE', '/users/:id', 'admin', handleDeleteUser);

// Part without scan
route('POST', '/parts', 'user', handleSubmitPart);
route('GET', '/parts/summary', 'user', handleMySummary);
route('GET', '/parts/month/:month', 'user', handleMyMonthEntries);
route('GET', '/parts/export', 'user', handleMyExport);
route('GET', '/parts/pending', 'admin', handlePending);
route('POST', '/parts/review', 'admin', handleReview);
route('GET', '/parts/admin-summary', 'admin', handleAdminSummary);
route('GET', '/parts/admin-export', 'admin', handleAdminExport);

// Preventive actions (machines)
route('GET', '/machines', 'user', handleListMachines);
route('POST', '/machines/:machine/issues', 'user', handleReportIssue);
route('POST', '/machines/:machine/checks/:id/action', 'user', handleCheckAction);
route('POST', '/machines/:machine/checks', 'admin', handleCreateCheck);
route('PUT', '/machines/:machine/owners', 'admin', handleSetOwners);
route('PATCH', '/machines/:machine/checks/:id', 'admin', handleUpdateCheck);
route('DELETE', '/machines/:machine/checks/:id', 'admin', handleDeleteCheck);

// Data migration / restore
route('POST', '/admin/import/users', 'admin', handleImportUsers);
route('POST', '/admin/import/tools', 'admin', handleImportTools);
route('POST', '/admin/import/tools-excel', 'admin', handleImportToolsExcel);
route('POST', '/admin/import/history', 'admin', handleImportHistory);
route('POST', '/admin/import/code', 'admin', handleImportCode);
route('POST', '/admin/import/parts', 'admin', handleImportParts);
route('POST', '/admin/import/settings', 'admin', handleImportSettings);


// Machines of this country
route('GET', '/features', 'user', handleGetFeatures);
route('GET', '/fleet', 'user', handleListFleet);
route('POST', '/fleet', 'admin', handleCreateMachine);
route('PATCH', '/fleet/:machine', 'admin', handleUpdateMachine);
route('DELETE', '/fleet/:machine', 'admin', handleRemoveMachine);

// First master account (Moroccan admins only, once)
route('GET', '/admin/master-account', 'admin', handleMasterAccountStatus);
route('POST', '/admin/master-account', 'admin', handleCreateFirstMaster);

// ---- Master hub (/master/api/...) ----
masterRoute('GET', '/auth/me', 'optional', handleMe);
masterRoute('POST', '/auth/login', 'public', handleLogin);
masterRoute('POST', '/auth/logout', 'public', handleLogout);
masterRoute('POST', '/auth/password', 'admin', handleChangeOwnPassword);
masterRoute('POST', '/auth/mfa/verify', 'public', handleMfaVerify);
masterRoute('POST', '/auth/mfa/setup', 'admin', handleMfaSetup);
masterRoute('POST', '/auth/mfa/enable', 'admin', handleMfaEnable);
masterRoute('POST', '/auth/mfa/disable', 'admin', handleMfaDisable);
masterRoute('GET', '/overview', 'admin', handleMasterOverview);
masterRoute('GET', '/countries/:region/admins', 'admin', handleCountryAdmins);
masterRoute('PUT', '/countries/:region/features', 'admin', handleSetCountryFeatures);
masterRoute('POST', '/countries/:region/admins', 'admin', handleCreateCountryAdmin);
masterRoute('GET', '/masters', 'admin', handleListMasters);
masterRoute('POST', '/masters', 'admin', handleCreateMaster);
masterRoute('DELETE', '/masters/:id', 'admin', handleDeleteMaster);
masterRoute('GET', '/audit', 'admin', handleAuditLog);

/** Headers added to every API response. The API only returns JSON, so it may do nothing else. */
const API_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
};

function withSecurityHeaders(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) res.headers.set(k, v);
  if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** Write requests must come from this site's own pages (defence in depth next to SameSite + the client header). */
function assertSameOrigin(request: Request, url: URL): void {
  // CSRF guard: browsers cannot add custom headers to cross-site form posts.
  if (request.headers.get('X-CNC-Client') !== '1') throw new HttpError(403, 'Missing client header');
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request refused');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
}

/**
 * Which instance a request belongs to, from its path:
 *   /ma/api/...      Morocco      /tr/api/...  Türkiye      /master/api/...  master hub
 *   /api/...         Morocco (the address used before there were several countries; kept so
 *                    shop-floor PCs that still run the previous version keep working)
 */
function resolveInstance(pathname: string): { instance: RegionId | 'master'; rest: string } | null {
  const m = pathname.match(/^\/(ma|tr|master)\/api(\/.*)$/);
  if (m) return { instance: m[1] as RegionId | 'master', rest: m[2] };
  const legacy = pathname.match(/^\/api(\/.*)$/);
  return legacy ? { instance: 'ma', rest: legacy[1] } : null;
}

/**
 * The environment a handler sees. `DB` is replaced by the one database of the instance, so a
 * country's code can never read another country. Master requests also get every country's
 * database (read for the dashboard, and to create a country's admins).
 */
function instanceEnv(env: Env, instance: RegionId | 'master'): Env | null {
  if (instance === 'master') {
    if (!env.DB_HUB) return null;
    const countries: Partial<Record<RegionId, D1Database>> = {};
    for (const r of REGIONS) {
      const db = (env as unknown as Record<string, D1Database | undefined>)[r.dbBinding];
      if (db) countries[r.id] = db;
    }
    return { ...env, DB: env.DB_HUB, DB_TR: undefined, DB_HUB: undefined, HUB: undefined, COUNTRIES: countries, REGION: 'master' };
  }
  const region = regionById(instance)!;
  const db = (env as unknown as Record<string, D1Database | undefined>)[region.dbBinding];
  if (!db) return null;
  return { ...env, DB: db, DB_TR: undefined, DB_HUB: undefined, HUB: env.DB_HUB, COUNTRIES: undefined, REGION: instance };
}

async function handleApi(request: Request, rawEnv: Env, url: URL, instance: RegionId | 'master', rest: string): Promise<Response> {
  const write = request.method !== 'GET' && request.method !== 'HEAD';
  if (write) assertSameOrigin(request, url);

  const env = instanceEnv(rawEnv, instance);
  if (!env) throw new HttpError(503, 'This country is not available yet.');
  const table = instance === 'master' ? masterRoutes : routes;
  const routeUrl = new URL(`/api${rest}${url.search}`, url.origin);

  let pathMatched = false;
  for (const r of table) {
    const m = r.pattern.exec(routeUrl);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;

    await ensureSchema(env.DB, instance);
    // A feature switched off for this country (by a master admin) does not exist there.
    if (instance !== 'master') {
      const feature = featureOfApiPath(rest);
      if (feature && !(await readFeatures(env.DB, instance))[feature]) throw new HttpError(404, 'Not found');
    }
    const session = r.access === 'public' ? null : await getSessionUser(env, request);
    const user = session?.user ?? null;
    if ((r.access === 'user' || r.access === 'admin') && !user) throw new HttpError(401, 'Not signed in');
    if (r.access === 'admin' && user!.role !== 'ADMIN') {
      await audit(env, request, 'admin_denied', user, `${request.method} ${url.pathname}`);
      throw new HttpError(403, 'Admin access required');
    }

    const params: Record<string, string> = {};
    try {
      for (const [k, v] of Object.entries(m.pathname.groups)) if (v !== undefined) params[k] = decodeURIComponent(v);
    } catch {
      throw new HttpError(400, 'Invalid URL');
    }

    const response = await r.handler({ env, request, url, params, user });
    for (const c of session?.setCookies ?? []) response.headers.append('Set-Cookie', c);
    // Every admin change is written to the security log (user changes log their own, more precise, entry).
    if (r.access === 'admin' && write && response.ok && !/\/api\/(users|auth)\b/.test(url.pathname)) {
      await audit(env, request, 'admin_action', user, `${request.method} ${url.pathname}`);
    }
    return response;
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
}

async function respond(request: Request, env: Env, url: URL, instance: RegionId | 'master', rest: string): Promise<Response> {
  const language = instance === 'master' ? 'en' : regionById(instance)?.language;
  try {
    return await handleApi(request, env, url, instance, rest);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: translateMessage(err.message, language), ...err.extra }, err.status);
    // Log only the message: never request bodies, cookies or stack traces with user data.
    const message = err instanceof Error ? err.message : String(err);
    console.error('Unhandled API error', request.method, url.pathname, message);
    if (/daily row (read|write) limit/i.test(message)) {
      return json({ error: translateMessage('The free Cloudflare database quota for today is used up. It resets at midnight UTC.', language) }, 503);
    }
    return json({ error: translateMessage('Server error. Please try again.', language) }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const target = resolveInstance(url.pathname);
    if (!target) return env.ASSETS.fetch(request);
    return withSecurityHeaders(await respond(request, env, url, target.instance, target.rest));
  },
} satisfies ExportedHandler<Env>;
