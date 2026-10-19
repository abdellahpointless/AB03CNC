import { HttpError, json } from './http';
import { ensureSchema } from './schema';
import type { Ctx, Env } from './context';
import {
  getSessionUser,
  handleChangeOwnPassword,
  handleLogin,
  handleLogout,
  handleMe,
  handleSetup,
} from './auth';
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
  handleImportUsers,
} from './routes/admin';

type Access = 'public' | 'optional' | 'user' | 'admin';
type Handler = (ctx: Ctx) => Promise<Response>;

const routes: { method: string; pattern: URLPattern; access: Access; handler: Handler }[] = [];

function route(method: string, path: string, access: Access, handler: Handler) {
  routes.push({ method, pattern: new URLPattern({ pathname: `/api${path}` }), access, handler });
}

// Auth
route('GET', '/auth/me', 'optional', handleMe);
route('POST', '/auth/login', 'public', handleLogin);
route('POST', '/auth/logout', 'public', handleLogout);
route('POST', '/auth/setup', 'public', handleSetup);
route('POST', '/auth/password', 'user', handleChangeOwnPassword);

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
route('POST', '/admin/import/history', 'admin', handleImportHistory);
route('POST', '/admin/import/code', 'admin', handleImportCode);
route('POST', '/admin/import/parts', 'admin', handleImportParts);
route('POST', '/admin/import/settings', 'admin', handleImportSettings);

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // CSRF guard: browsers cannot add custom headers to cross-site form posts.
  if (request.method !== 'GET' && request.headers.get('X-CNC-Client') !== '1') {
    throw new HttpError(403, 'Missing client header');
  }

  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(url);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;

    await ensureSchema(env.DB);
    const session = r.access === 'public' ? null : await getSessionUser(env, request);
    const user = session?.user ?? null;
    if ((r.access === 'user' || r.access === 'admin') && !user) throw new HttpError(401, 'Not signed in');
    if (r.access === 'admin' && user!.role !== 'ADMIN') throw new HttpError(403, 'Admin access required');

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.pathname.groups)) if (v !== undefined) params[k] = decodeURIComponent(v);

    const response = await r.handler({ env, request, url, params, user });
    if (session?.renewCookie) response.headers.append('Set-Cookie', session.renewCookie);
    return response;
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error('Unhandled API error', err);
      const message = err instanceof Error ? err.message : String(err);
      if (/daily row (read|write) limit/i.test(message)) {
        return json({ error: 'The free Cloudflare database quota for today is used up. It resets at midnight UTC.' }, 503);
      }
      return json({ error: 'Server error. Please try again.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
