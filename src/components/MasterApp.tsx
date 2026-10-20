import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Crown,
  Factory,
  KeyRound,
  LogOut,
  Package,
  RefreshCw,
  ShieldCheck,
  Timer,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { setLanguage, useT } from '../i18n';
import { fmtDateTime, fmtDuration, fmtMonth, fmtNumber, timeAgo } from '../i18n/format';
import { HUB_PATH } from '../lib/instance';
import type { RegionId } from '../regions';
import { Flag } from './Flag';
import Login from './Login';
import { ChangePasswordModal } from './ChangePasswordModal';
import { SPRING_POP } from '../lib/motion';

// ---- Data from GET /master/api/overview -------------------------------------------------

interface CountryMetrics {
  configured: boolean;
  users: { admins: number; machinists: number; adminsWithMfa: number };
  programs: { total: number; last30Days: number; appSelected: number; manual: number; savedSecondsPerProgram: number; timeSavedSeconds: number; lastAt: number | null };
  monthly: { month: string; programs: number; partsQty: number; partsValue: number }[];
  parts: { pending: number; thisMonthQty: number; thisMonthValue: number };
  machines: { total: number; withTools: number; problems: number; dueChecks: number; list: { id: string; name: string; problems: number; due: number }[] };
  tools: { total: number };
  topOperators: { username: string; programs: number }[];
  security: { failedSignIns7d: number; lockouts7d: number };
}

type Country = { id: RegionId; name: string; nativeName: string; language: string } & (
  | ({ available: true } & CountryMetrics)
  | { available: false; error?: string }
);

interface Overview {
  generatedAt: number;
  countries: Country[];
}

type ActiveCountry = Extract<Country, { available: true }>;
const isActive = (c: Country): c is ActiveCountry => c.available && (c as ActiveCountry).configured;
const SERIES: Record<RegionId, string> = { ma: 'var(--series-ma)', tr: 'var(--series-tr)' };

/** /master/: the master admin's sign-in, then the dashboard. */
export default function MasterApp() {
  const { user, status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-xs text-[var(--text-tertiary)] gap-2">
        <RefreshCw size={14} className="animate-spin" />
      </div>
    );
  }
  return user ? <MasterDashboard /> : <Login />;
}

function MasterDashboard() {
  const { t, i18n } = useT('master');
  const { user, logout, mfaEnabled } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [security, setSecurity] = useState<false | 'password' | 'mfa'>(false);
  const [adminFor, setAdminFor] = useState<RegionId | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setData(await api<Overview>(fresh ? '/overview?fresh=1' : '/overview'));
      setError('');
    } catch (e) {
      setError(errorMessage(e, t('common:errors.generic')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Numbers are cached on the server for 10 minutes; refresh only while this tab is visible.
  useEffect(() => {
    load(reload > 0);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10 * 60_000);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, reload]);

  const switchLanguage = async (lng: 'en' | 'tr') => {
    try {
      localStorage.setItem('master:cnc-lang', lng);
    } catch {
      /* ignore */
    }
    await setLanguage(lng);
  };

  const active = (data?.countries ?? []).filter(isActive);

  return (
    <div className="min-h-screen pb-16">
      <AnimatePresence>
        {security && <ChangePasswordModal key="security" initialTab={security} onClose={() => setSecurity(false)} />}
        {adminFor && (
          <CreateAdminModal
            key="admin"
            region={adminFor}
            onClose={() => setAdminFor(null)}
            onCreated={() => {
              setReload((n) => n + 1);
            }}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="px-4 sm:px-6 pt-4 relative z-20">
        <header className="glass-panel px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-[var(--radius-md)] bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center text-white shadow-[0_4px_16px_rgba(245,158,11,0.35)] shrink-0">
              <Crown size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold text-[var(--text-primary)] leading-tight">{t('title')}</h1>
              <p className="text-[11px] text-[var(--text-secondary)] truncate">{t('subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {data && <span className="text-[11px] text-[var(--text-tertiary)] hidden md:inline">{t('updated', { time: fmtDateTime(data.generatedAt) })}</span>}
            <div className="flex rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden text-[11px] font-semibold" role="group" aria-label={t('language')}>
              {(['en', 'tr'] as const).map((lng) => (
                <button
                  key={lng}
                  type="button"
                  onClick={() => switchLanguage(lng)}
                  className={`no-glass px-2.5 py-1.5 ${i18n.language === lng ? 'bg-[var(--blue-500)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                >
                  {lng.toUpperCase()}
                </button>
              ))}
            </div>
            <span className="badge-neutral text-xs py-1 px-2.5 hidden sm:inline-flex">
              <Crown size={12} className="text-amber-500" /> {user?.username}
            </span>
            <button onClick={() => load(true)} className="btn-icon" title={t('common:actions.refresh')} aria-label={t('common:actions.refresh')}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setSecurity('password')} className="btn-icon" title={t('security')} aria-label={t('security')}>
              <KeyRound size={15} />
            </button>
            <button
              onClick={async () => {
                await logout();
                window.location.assign(HUB_PATH);
              }}
              className="btn-icon"
              title={t('common:actions.signOut')}
              aria-label={t('common:actions.signOut')}
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>
      </div>

      <main className="px-4 sm:px-6 pt-5 space-y-6 max-w-7xl mx-auto">
        {!mfaEnabled && (
          <div className="p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold">
              <ShieldCheck size={16} className="shrink-0 text-[var(--blue-500)]" />
              <span>{t('mfaNudge')}</span>
            </div>
            <button onClick={() => setSecurity('mfa')} className="btn-primary text-xs py-1 px-3 shrink-0">
              {t('mfaTurnOn')}
            </button>
          </div>
        )}

        {error && <div className="badge-danger w-full justify-center py-2 text-xs">{error}</div>}
        {!data && !error && (
          <div className="aurora-card p-10 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" /> {t('common:status.loading')}
          </div>
        )}

        {data && (
          <>
            {/* One card per country */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {data.countries.map((c, i) => (
                <CountryCard key={c.id} country={c} index={i} onCreateAdmin={() => setAdminFor(c.id)} />
              ))}
            </div>

            {active.length > 0 && (
              <>
                <ComparisonTable countries={active} />
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <MonthlyChart countries={active} kind="programs" />
                  <MonthlyChart countries={active} kind="parts" />
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <MachineHealth countries={active} />
                  <TopOperators countries={active} />
                </div>
              </>
            )}

            <CountryAdmins countries={data.countries} reload={reload} onAdd={(r) => setAdminFor(r)} />
            <MasterAccounts />
          </>
        )}
      </main>
    </div>
  );
}

// ---- Country summary ---------------------------------------------------------------------

function Stat({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail?: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="p-3 rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.03)] border border-[var(--border-subtle)] min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${tone === 'danger' ? 'text-[var(--rose-500)]' : tone === 'warning' ? 'text-[var(--orange-500)]' : 'text-[var(--text-primary)]'}`}>
        {value}
      </div>
      {detail && <div className="text-[11px] text-[var(--text-tertiary)] truncate">{detail}</div>}
    </div>
  );
}

function CountryCard({ country, index, onCreateAdmin }: { country: Country; index: number; onCreateAdmin: () => void }) {
  const { t } = useT('master');
  const active = isActive(country);
  const status = !country.available ? 'notConnected' : active ? 'active' : 'notSetUp';
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING_POP, delay: index * 0.06 }}
      className="aurora-card aurora-card-static p-5 space-y-4"
      style={{ borderTop: `3px solid ${SERIES[country.id]}` }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Flag country={country.id} className="w-10 h-[27px] rounded-[4px] shadow-sm" />
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)] leading-tight">{t(`common:country.${country.id}`)}</h2>
            <div className="text-[11px] text-[var(--text-tertiary)]">{t(`common:language.${country.language as 'en' | 'tr'}`)}</div>
          </div>
        </div>
        <span className={status === 'active' ? 'badge-positive' : status === 'notSetUp' ? 'badge-warning' : 'badge-neutral'}>{t(`status.${status}`)}</span>
      </div>

      {!country.available && <p className="text-xs text-[var(--text-secondary)]">{country.error ?? t('card.notConnectedText')}</p>}
      {country.available && !active && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-[var(--text-secondary)]">{t('card.notSetUpText')}</p>
          <button onClick={onCreateAdmin} className="btn-primary text-xs py-2 px-4 whitespace-nowrap">
            <UserPlus size={14} />
            <span>{t('card.createFirstAdmin')}</span>
          </button>
        </div>
      )}
      {active && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat icon={<Activity size={13} />} label={t('card.programs')} value={fmtNumber(country.programs.total, 0)} detail={t('card.last30', { count: country.programs.last30Days })} />
            <Stat icon={<Timer size={13} />} label={t('card.timeSaved')} value={fmtDuration(country.programs.timeSavedSeconds)} />
            <Stat
              icon={<Package size={13} />}
              label={t('card.partsMonth')}
              value={fmtNumber(country.parts.thisMonthQty, 0)}
              detail={country.parts.pending ? t('card.pending', { count: country.parts.pending }) : t('card.partsValue', { value: fmtNumber(country.parts.thisMonthValue, 1) })}
            />
            <Stat
              icon={<AlertTriangle size={13} />}
              label={t('card.problems')}
              value={fmtNumber(country.machines.problems, 0)}
              detail={t('card.due', { count: country.machines.dueChecks })}
              tone={country.machines.problems ? 'danger' : undefined}
            />
            <Stat icon={<Factory size={13} />} label={t('card.machines')} value={fmtNumber(country.machines.total, 0)} detail={t('card.tools', { count: country.tools.total })} />
            <Stat
              icon={<Users size={13} />}
              label={t('card.people')}
              value={fmtNumber(country.users.admins + country.users.machinists, 0)}
              detail={t('card.peopleDetail', { admins: country.users.admins, machinists: country.users.machinists })}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck size={12} className={country.users.adminsWithMfa < country.users.admins ? 'text-[var(--orange-500)]' : 'text-[var(--green-500)]'} />
              {t('card.mfa', { count: country.users.adminsWithMfa, total: country.users.admins })}
            </span>
            <span className={country.security.failedSignIns7d > 20 ? 'text-[var(--orange-500)]' : ''}>{t('card.failed', { count: country.security.failedSignIns7d })}</span>
            <span>{country.programs.lastAt ? t('card.lastActivity', { time: timeAgo(country.programs.lastAt) }) : t('card.noActivity')}</span>
          </div>
        </>
      )}
    </motion.section>
  );
}

// ---- Comparison table (also the accessible view of the cards) --------------------------------

function ComparisonTable({ countries }: { countries: ActiveCountry[] }) {
  const { t } = useT('master');
  const pct = (a: number, b: number) => (a + b ? `${fmtNumber((a / (a + b)) * 100, 0)} %` : '-');
  const rows: { label: string; value: (c: ActiveCountry) => string }[] = [
    { label: t('compare.programsTotal'), value: (c) => fmtNumber(c.programs.total, 0) },
    { label: t('compare.programs30'), value: (c) => fmtNumber(c.programs.last30Days, 0) },
    { label: t('compare.timeSaved'), value: (c) => fmtDuration(c.programs.timeSavedSeconds) },
    { label: t('compare.autoShare'), value: (c) => pct(c.programs.appSelected, c.programs.manual) },
    { label: t('compare.partsMonth'), value: (c) => fmtNumber(c.parts.thisMonthQty, 0) },
    { label: t('compare.partsPending'), value: (c) => fmtNumber(c.parts.pending, 0) },
    { label: t('compare.machines'), value: (c) => fmtNumber(c.machines.total, 0) },
    { label: t('compare.tools'), value: (c) => fmtNumber(c.tools.total, 0) },
    { label: t('compare.problems'), value: (c) => fmtNumber(c.machines.problems, 0) },
    { label: t('compare.due'), value: (c) => fmtNumber(c.machines.dueChecks, 0) },
    { label: t('compare.users'), value: (c) => `${c.users.admins} / ${c.users.machinists}` },
    { label: t('compare.mfa'), value: (c) => `${c.users.adminsWithMfa} / ${c.users.admins}` },
    { label: t('compare.failed'), value: (c) => fmtNumber(c.security.failedSignIns7d, 0) },
  ];
  return (
    <section className="aurora-card aurora-card-static p-0 overflow-hidden">
      <div className="p-4 border-b border-[var(--border-subtle)]">
        <h3 className="section-label text-[var(--text-primary)]">{t('compare.title')}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
              <th className="p-3 section-label">{t('compare.metric')}</th>
              {countries.map((c) => (
                <th key={c.id} className="p-3 section-label text-right">
                  <span className="inline-flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: SERIES[c.id] }} aria-hidden />
                    {t(`common:country.${c.id}`)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[rgba(var(--ov),0.02)]">
                <td className="p-3 text-[var(--text-secondary)]">{r.label}</td>
                {countries.map((c) => (
                  <td key={c.id} className="p-3 text-right font-semibold tabular-nums text-[var(--text-primary)]">
                    {r.value(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Monthly charts ------------------------------------------------------------------------

function MonthlyChart({ countries, kind }: { countries: ActiveCountry[]; kind: 'programs' | 'parts' }) {
  const { t } = useT('master');
  const [showTable, setShowTable] = useState(false);
  const months = countries[0]?.monthly.map((m) => m.month) ?? [];
  const rows = useMemo(
    () =>
      months.map((month) => {
        const row: Record<string, string | number> = { month, label: fmtMonth(month, true) };
        for (const c of countries) {
          const m = c.monthly.find((x) => x.month === month);
          row[c.id] = kind === 'programs' ? m?.programs ?? 0 : m?.partsQty ?? 0;
        }
        return row;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [countries, kind, months.join()],
  );
  const empty = rows.every((r) => countries.every((c) => !r[c.id]));
  const title = kind === 'programs' ? t('charts.programsTitle') : t('charts.partsTitle');
  const unit = kind === 'programs' ? t('charts.programs') : t('charts.parts');
  const tooltipStyle = {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 10,
    color: 'var(--text-primary)',
    fontSize: 12,
  };
  const axis = { stroke: 'var(--text-tertiary)', fontSize: 11, tickLine: false, axisLine: false } as const;
  const name = (id: string) => t(`common:country.${id as RegionId}`);

  return (
    <section className="aurora-card aurora-card-static p-5">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="section-label text-[var(--text-primary)]">{title}</h3>
        <button type="button" onClick={() => setShowTable((v) => !v)} className="no-glass text-[11px] text-[var(--blue-500)] hover:underline">
          {showTable ? t('charts.hideTable') : t('charts.showTable')}
        </button>
      </div>
      {empty ? (
        <div className="h-56 flex items-center justify-center text-xs text-[var(--text-tertiary)]">{t('charts.empty')}</div>
      ) : showTable ? (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="p-2 text-left section-label">{t('charts.month')}</th>
                {countries.map((c) => (
                  <th key={c.id} className="p-2 text-right section-label">
                    {name(c.id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month as string} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="p-2 text-[var(--text-secondary)]">{fmtMonth(r.month as string)}</td>
                  {countries.map((c) => (
                    <td key={c.id} className="p-2 text-right tabular-nums text-[var(--text-primary)]">
                      {fmtNumber(r[c.id] as number, 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64" role="img" aria-label={title}>
          <ResponsiveContainer width="100%" height="100%">
            {kind === 'programs' ? (
              <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="rgba(var(--ov),0.06)" vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis allowDecimals={false} {...axis} width={44} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text-secondary)' }} formatter={(v: number, n: string) => [`${fmtNumber(v, 0)} ${unit}`, name(n)]} />
                <Legend formatter={(v: string) => <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{name(v)}</span>} />
                {countries.map((c) => (
                  <Line key={c.id} type="linear" dataKey={c.id} name={c.id} stroke={SERIES[c.id]} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: 'var(--bg-card)' }} activeDot={{ r: 6 }} />
                ))}
              </LineChart>
            ) : (
              <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }} barGap={2} barCategoryGap="22%">
                <CartesianGrid stroke="rgba(var(--ov),0.06)" vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis allowDecimals={false} {...axis} width={44} />
                <Tooltip cursor={{ fill: 'rgba(var(--ov),0.05)' }} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text-secondary)' }} formatter={(v: number, n: string) => [`${fmtNumber(v, 0)} ${unit}`, name(n)]} />
                <Legend formatter={(v: string) => <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{name(v)}</span>} />
                {countries.map((c) => (
                  <Bar key={c.id} dataKey={c.id} name={c.id} fill={SERIES[c.id]} radius={[4, 4, 0, 0]} maxBarSize={22} />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

// ---- Machine health and operators ----------------------------------------------------------

function MachineHealth({ countries }: { countries: ActiveCountry[] }) {
  const { t } = useT('master');
  return (
    <section className="aurora-card aurora-card-static p-5 space-y-4">
      <h3 className="section-label text-[var(--text-primary)]">{t('machines.title')}</h3>
      {countries.map((c) => {
        const attention = c.machines.list.filter((m) => m.problems || m.due).sort((a, b) => b.problems - a.problems || b.due - a.due);
        return (
          <div key={c.id} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
              <Flag country={c.id} className="w-5 h-[14px] rounded-[2px]" /> {t(`common:country.${c.id}`)}
            </div>
            {c.machines.list.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">{t('machines.none')}</p>
            ) : attention.length === 0 ? (
              <p className="text-xs text-[var(--green-500)] inline-flex items-center gap-1.5">
                <CheckCircle2 size={13} /> {t('machines.allGood')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {attention.slice(0, 6).map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 text-xs p-2 rounded-[var(--radius-sm)] bg-[rgba(var(--ov),0.03)]">
                    <span className="font-semibold text-[var(--text-primary)]">{m.name}</span>
                    <span className="flex items-center gap-2">
                      {m.problems > 0 && (
                        <span className="badge-danger text-[10px] py-0 px-2">
                          <AlertTriangle size={11} /> {t('machines.problems', { count: m.problems })}
                        </span>
                      )}
                      {m.due > 0 && (
                        <span className="badge-warning text-[10px] py-0 px-2">
                          <Clock size={11} /> {t('machines.due', { count: m.due })}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

function TopOperators({ countries }: { countries: ActiveCountry[] }) {
  const { t } = useT('master');
  return (
    <section className="aurora-card aurora-card-static p-5 space-y-4">
      <h3 className="section-label text-[var(--text-primary)]">{t('operators.title')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {countries.map((c) => {
          const max = Math.max(1, ...c.topOperators.map((o) => o.programs));
          return (
            <div key={c.id} className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <Flag country={c.id} className="w-5 h-[14px] rounded-[2px]" /> {t(`common:country.${c.id}`)}
              </div>
              {c.topOperators.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('operators.none')}</p>
              ) : (
                <ul className="space-y-2">
                  {c.topOperators.map((o) => (
                    <li key={o.username} className="text-xs">
                      <div className="flex justify-between gap-2">
                        <span className="text-[var(--text-primary)] font-medium truncate">{o.username}</span>
                        <span className="text-[var(--text-secondary)] tabular-nums shrink-0">{t('operators.programs', { count: o.programs })}</span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full bg-[rgba(var(--ov),0.06)] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(o.programs / max) * 100}%`, background: SERIES[c.id] }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- Country admins and master accounts ----------------------------------------------------

interface AccountRow {
  id: string;
  username: string;
  created_at: number;
  mfa_enabled: number;
}

function CountryAdmins({ countries, reload, onAdd }: { countries: Country[]; reload: number; onAdd: (r: RegionId) => void }) {
  const { t } = useT('master');
  const [admins, setAdmins] = useState<Partial<Record<RegionId, AccountRow[]>>>({});
  useEffect(() => {
    for (const c of countries) {
      if (!c.available) continue;
      api<{ admins: AccountRow[] }>(`/countries/${c.id}/admins`)
        .then((r) => setAdmins((prev) => ({ ...prev, [c.id]: r.admins })))
        .catch(() => {});
    }
  }, [countries, reload]);
  return (
    <section className="aurora-card aurora-card-static p-5 space-y-4">
      <div>
        <h3 className="section-label text-[var(--text-primary)]">{t('admins.title')}</h3>
        <p className="text-xs text-[var(--text-secondary)] mt-1">{t('admins.subtitle')}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {countries
          .filter((c) => c.available)
          .map((c) => (
            <div key={c.id} className="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                  <Flag country={c.id} className="w-5 h-[14px] rounded-[2px]" /> {t(`common:country.${c.id}`)}
                </div>
                <button onClick={() => onAdd(c.id)} className="btn-secondary text-xs py-1 px-3">
                  <UserPlus size={13} /> <span>{t('admins.add')}</span>
                </button>
              </div>
              {(admins[c.id] ?? []).length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('admins.none')}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {(admins[c.id] ?? []).map((a) => (
                    <li key={a.id} className="badge-neutral text-xs py-1 px-2.5">
                      {a.username}
                      {!!a.mfa_enabled && (
                        <span className="text-[var(--green-500)] inline-flex items-center gap-0.5 ml-1">
                          <ShieldCheck size={11} /> {t('admins.twoStep')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
      </div>
    </section>
  );
}

function AccountForm({
  onSubmit,
  button,
  confirmWithOwnPassword = false,
}: {
  onSubmit: (username: string, password: string, currentPassword: string) => Promise<void>;
  button: string;
  confirmWithOwnPassword?: boolean;
}) {
  const { t } = useT('master');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSubmit(username.trim(), password, currentPassword);
          setUsername('');
          setPassword('');
          setCurrentPassword('');
        } catch (err) {
          setError(errorMessage(err, t('common:errors.generic')));
        } finally {
          setBusy(false);
        }
      }}
      className="space-y-3"
    >
      <input className="aurora-input w-full text-xs" placeholder={t('admins.username')} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={40} required autoFocus />
      <input className="aurora-input w-full text-xs" type="password" placeholder={t('admins.password')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={200} required />
      <p className="text-[11px] text-[var(--text-tertiary)]">{t('admins.hint')}</p>
      {confirmWithOwnPassword && (
        <input className="aurora-input w-full text-xs" type="password" placeholder={t('masters.yourPassword')} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
      )}
      {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
      <button type="submit" disabled={busy} className="btn-primary w-full text-xs py-2">
        {busy ? t('common:status.working') : button}
      </button>
    </form>
  );
}

function CreateAdminModal({ region, onClose, onCreated }: { region: RegionId; onClose: () => void; onCreated: () => void }) {
  const { t } = useT('master');
  const [done, setDone] = useState('');
  const country = t(`common:country.${region}`);
  return (
    <motion.div
      className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div className="glass-modal max-w-sm w-full p-6" initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING_POP}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Flag country={region} className="w-6 h-4 rounded-[2px]" /> {t('admins.add')}
          </h3>
          <button onClick={onClose} className="btn-icon w-7 h-7" title={t('common:actions.close')}>
            <X size={14} />
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <div className="badge-positive w-full py-2 px-3 text-xs">{done}</div>
            <button onClick={onClose} className="btn-primary w-full text-xs py-2">
              {t('common:actions.close')}
            </button>
          </div>
        ) : (
          <AccountForm
            button={t('admins.create')}
            onSubmit={async (username, password) => {
              await api(`/countries/${region}/admins`, { method: 'POST', body: { username, password } });
              setDone(t('admins.created', { name: username, country }));
              onCreated();
            }}
          />
        )}
      </motion.div>
    </motion.div>
  );
}

function MasterAccounts() {
  const { t } = useT('master');
  const { user } = useAuth();
  const [masters, setMasters] = useState<AccountRow[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(() => {
    api<{ masters: AccountRow[] }>('/masters')
      .then((r) => setMasters(r.masters))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  return (
    <section className="aurora-card aurora-card-static p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="section-label text-[var(--text-primary)] inline-flex items-center gap-2">
          <Crown size={14} className="text-amber-500" /> {t('masters.title')}
        </h3>
        {!open && (
          <button onClick={() => setOpen(true)} className="btn-secondary text-xs py-1 px-3">
            <UserPlus size={13} /> <span>{t('masters.add')}</span>
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {masters.map((m) => (
          <li key={m.id} className="badge-neutral text-xs py-1 px-2.5">
            {m.username}
            {!!m.mfa_enabled && (
              <span className="text-[var(--green-500)] inline-flex items-center gap-0.5 ml-1">
                <ShieldCheck size={11} /> {t('admins.twoStep')}
              </span>
            )}
            {m.id !== user?.id && masters.length > 1 && (
              <button
                type="button"
                className="no-glass ml-1 text-[var(--text-tertiary)] hover:text-[var(--rose-500)]"
                title={t('masters.remove')}
                aria-label={`${t('masters.remove')} ${m.username}`}
                onClick={async () => {
                  if (!confirm(t('masters.confirmRemove', { name: m.username }))) return;
                  try {
                    await api(`/masters/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
                    setNotice(t('masters.removed', { name: m.username }));
                    load();
                  } catch (e) {
                    setNotice(errorMessage(e, t('common:errors.generic')));
                  }
                }}
              >
                <X size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {notice && <div className="badge-positive text-xs py-1.5 px-3">{notice}</div>}
      {open && (
        <div className="max-w-sm">
          <AccountForm
            button={t('masters.create')}
            confirmWithOwnPassword
            onSubmit={async (username, password, currentPassword) => {
              await api('/masters', { method: 'POST', body: { username, password, currentPassword } });
              setNotice(t('masters.created', { name: username }));
              setOpen(false);
              load();
            }}
          />
        </div>
      )}
    </section>
  );
}

