import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { formatTimeWon, DEFAULT_SAVED_SECONDS_PER_EXTRACTION } from '../lib/extractionAnalytics';
import { api } from '../lib/api';
import { TimeWonClock } from './TimeWonClock';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';
import {
  User,
  BarChart3,
  Sliders,
  Award,
  PieChart as PieIcon,
  Sparkles,
  Wrench,
  CheckCircle2,
  Info
} from 'lucide-react';


const BAR_COLORS = [
  '#3b6fd4', // blue-500
  '#16a34a', // green-500
  '#e08a4d', // orange-500
  '#ff6679', // rose-500
  '#6366f1', // indigo
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#10b981'  // emerald
];

export default function AdminExtractionAnalytics() {
  const { user } = useAuth();
  const { analytics: liveAnalytics, versions, refreshNow } = useSync();
  const [showSettings, setShowSettings] = useState(false);
  const [users, setUsers] = useState<{ username: string; role: string }[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    api<{ users: { username: string; role: string }[] }>('/users')
      .then(res => setUsers(res.users))
      .catch(() => {});
  }, [user?.role, versions.users]);

  // Security guard: STRICTLY visible only to ADMIN
  if (user?.role !== 'ADMIN') {
    return null;
  }

  const savedSeconds = liveAnalytics?.savedSecondsPerExtraction ?? DEFAULT_SAVED_SECONDS_PER_EXTRACTION;
  const analytics = {
    totalExtractions: liveAnalytics?.totalExtractions ?? 0,
    userList: liveAnalytics?.users ?? [],
  };

  const setSavedSeconds = async (secs: number) => {
    setSettingsError(null);
    try {
      await api('/settings/saved-seconds', { method: 'PUT', body: { seconds: secs } });
      await refreshNow();
    } catch (err: any) {
      setSettingsError(err?.message || 'Could not save the setting');
    }
  };

  // Tools matched automatically by the app vs changed manually (all-time, from every extraction)
  const liveAppSelected = liveAnalytics?.appSelected ?? 0;
  const liveManualChanged = liveAnalytics?.manualChanged ?? 0;

  const hasLiveData = (liveAppSelected + liveManualChanged) > 0;
  // If no live runs yet, show baseline preview so the pie chart is ALWAYS visible
  const appSelectedToolsCount = hasLiveData ? liveAppSelected : 18;
  const manualChangedToolsCount = hasLiveData ? liveManualChanged : 4;
  const totalEvaluatedTools = appSelectedToolsCount + manualChangedToolsCount;

  const appSelectedPercentage = Math.round((appSelectedToolsCount / totalEvaluatedTools) * 100);
  const manualChangedPercentage = 100 - appSelectedPercentage;

  // Donut SVG circumference calculation (radius = 70, circumference = 2 * PI * 70 ≈ 439.82)
  const donutRadius = 70;
  const donutCircumference = 2 * Math.PI * donutRadius;
  const appSelectedStrokeDash = (appSelectedPercentage / 100) * donutCircumference;
  const manualStrokeDash = (manualChangedPercentage / 100) * donutCircumference;

  // Prepare data for the Bar Chart
  const chartDataMap: Record<string, { username: string; extractions: number; timeSavedSeconds: number; role?: string }> = {};

  if (Array.isArray(users)) {
    users.forEach((u: any) => {
      const uname = (u.username || '').trim();
      if (uname) {
        chartDataMap[uname] = {
          username: uname,
          extractions: 0,
          timeSavedSeconds: 0,
          role: u.role
        };
      }
    });
  }

  analytics.userList.forEach(u => {
    if (chartDataMap[u.username]) {
      chartDataMap[u.username].extractions = u.extractions;
      chartDataMap[u.username].timeSavedSeconds = u.timeSavedSeconds;
    } else {
      chartDataMap[u.username] = {
        username: u.username,
        extractions: u.extractions,
        timeSavedSeconds: u.timeSavedSeconds
      };
    }
  });

  const chartData = Object.values(chartDataMap).sort((a, b) => b.extractions - a.extractions);

  // Custom tooltip for Recharts Bar Chart in Aurora Glass
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const userTimeWon = formatTimeWon(data.timeSavedSeconds);
      const percent = analytics.totalExtractions > 0
        ? Math.round((data.extractions / analytics.totalExtractions) * 100)
        : 0;

      return (
        <div className="glass-modal p-3.5 text-xs z-50 min-w-[200px] shadow-2xl">
          <div className="flex items-center gap-2 font-bold text-[var(--text-primary)] mb-2 border-b border-[var(--border-subtle)] pb-1.5">
            <User size={13} className="text-[var(--accent-primary)]" />
            <span>{data.username}</span>
            {data.role && (
              <span className="badge-neutral text-[9px] py-0 px-1.5 font-mono ml-auto">
                {data.role}
              </span>
            )}
          </div>
          <div className="space-y-1.5 font-mono text-[11px]">
            <div className="flex justify-between gap-4">
              <span className="text-[var(--text-secondary)]">Codes Extracted:</span>
              <span className="font-bold text-[var(--accent-primary)]">{data.extractions}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[var(--text-secondary)]">Time Saved:</span>
              <span className="font-bold text-[var(--green-500)]">{userTimeWon.formatted}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[var(--text-secondary)]">Team Share:</span>
              <span className="font-bold text-[var(--text-primary)]">{percent}%</span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6 w-full max-w-5xl mx-auto pb-12">
      {/* 1. Time Won Clock Card */}
      <TimeWonClock />

      {/* 2. Tool Selection Method PIE CHART Card (App Selected vs Manual Changes) */}
      <div className="aurora-card p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5 border-b border-[var(--border-subtle)] pb-4">
          <div className="flex items-center gap-3">
            <span className="p-2.5 bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 text-[var(--green-500)] rounded-[var(--radius-md)]">
              <PieIcon size={20} />
            </span>
            <div>
              <h3 className="text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
                Tool Selection Distribution
                <span className={hasLiveData ? "badge-positive text-[10px] py-0.5 px-2" : "badge-neutral text-[10px] py-0.5 px-2"}>
                  {hasLiveData ? "Live Telemetry" : "Benchmark Preview"}
                </span>
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Ratio of tools automatically matched by the app versus modified manually by operators.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="badge-neutral text-[11px] py-1 px-2.5">
              {hasLiveData ? 'Total Evaluated: ' : 'Sample Total: '}
              <strong className="text-[var(--text-primary)] ml-1">{totalEvaluatedTools} tools</strong>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
          {/* Always-visible SVG Donut / Pie Chart */}
          <div className="md:col-span-6 flex flex-col items-center justify-center p-3 relative">
            <div className="relative w-56 h-56 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 180 180">
                {/* Background Ring */}
                <circle
                  cx="90"
                  cy="90"
                  r={donutRadius}
                  stroke="rgba(var(--ov),0.08)"
                  strokeWidth="20"
                  fill="transparent"
                />
                
                {/* Manual Changed Arc (Orange) */}
                <circle
                  cx="90"
                  cy="90"
                  r={donutRadius}
                  stroke="#ea580c"
                  strokeWidth="22"
                  strokeDasharray={`${donutCircumference} ${donutCircumference}`}
                  strokeDashoffset="0"
                  fill="transparent"
                  className="transition-all duration-700 ease-out"
                />

                {/* App Selected Arc (Emerald Green) */}
                <circle
                  cx="90"
                  cy="90"
                  r={donutRadius}
                  stroke="#16a34a"
                  strokeWidth="22"
                  strokeDasharray={`${appSelectedStrokeDash} ${donutCircumference}`}
                  strokeDashoffset="0"
                  fill="transparent"
                  className="transition-all duration-700 ease-out"
                />
              </svg>

              {/* Center Donut Hole & Percentage Display */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
                <span className="text-3xl font-extrabold font-mono text-[var(--green-500)] tracking-tight">
                  {appSelectedPercentage}%
                </span>
                <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-tertiary)] mt-0.5">
                  App Selected
                </span>
                <span className="text-[9px] font-mono text-[var(--orange-500)] font-medium">
                  {manualChangedPercentage}% Manual
                </span>
              </div>
            </div>

            {/* Quick Legend under Pie */}
            <div className="flex items-center gap-5 mt-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-[#16a34a] shadow-xs" />
                <span className="text-[var(--text-secondary)]">App Selected ({appSelectedPercentage}%)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-[#ea580c] shadow-xs" />
                <span className="text-[var(--text-secondary)]">Manual ({manualChangedPercentage}%)</span>
              </div>
            </div>
          </div>

          {/* Metrics Breakdown Cards */}
          <div className="md:col-span-6 space-y-3.5">
            {/* App Selected Card */}
            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--green-500)]/30 bg-[rgba(22,163,74,0.08)] flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--green-500)]/20 border border-[var(--green-500)]/40 flex items-center justify-center text-[var(--green-500)] shrink-0">
                  <Sparkles size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-[var(--text-primary)]">
                      Selected by the App
                    </span>
                    <span className="badge-positive text-[10px] py-0 px-2 font-mono">
                      Automated
                    </span>
                  </div>
                  <span className="text-[11px] text-[var(--text-secondary)] block mt-0.5">
                    Matched directly from machine toolbox
                  </span>
                </div>
              </div>

              <div className="text-right">
                <div className="font-mono text-2xl font-bold text-[var(--green-500)] leading-none">
                  {appSelectedPercentage}%
                </div>
                <span className="text-[11px] font-mono text-[var(--text-tertiary)] mt-1 block">
                  {appSelectedToolsCount} {appSelectedToolsCount === 1 ? 'tool' : 'tools'}
                </span>
              </div>
            </div>

            {/* Manually Changed Card */}
            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--orange-500)]/30 bg-[rgba(224,138,77,0.08)] flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--orange-500)]/20 border border-[var(--orange-500)]/40 flex items-center justify-center text-[var(--orange-500)] shrink-0">
                  <Wrench size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-[var(--text-primary)]">
                      Changed Manually
                    </span>
                    <span className="badge-warning text-[10px] py-0 px-2 font-mono">
                      Manual Choice
                    </span>
                  </div>
                  <span className="text-[11px] text-[var(--text-secondary)] block mt-0.5">
                    Resolved or overridden by machinist
                  </span>
                </div>
              </div>

              <div className="text-right">
                <div className="font-mono text-2xl font-bold text-[var(--orange-500)] leading-none">
                  {manualChangedPercentage}%
                </div>
                <span className="text-[11px] font-mono text-[var(--text-tertiary)] mt-1 block">
                  {manualChangedToolsCount} {manualChangedToolsCount === 1 ? 'tool' : 'tools'}
                </span>
              </div>
            </div>

            {/* Status notification */}
            {!hasLiveData ? (
              <div className="p-2.5 rounded-[var(--radius-sm)] bg-[rgba(59,111,212,0.08)] border border-[var(--blue-500)]/30 text-[11px] text-[var(--text-secondary)] flex items-center gap-2">
                <Info size={14} className="text-[var(--accent-primary)] shrink-0" />
                <span>
                  Showing baseline benchmark preview. As programs are remapped and extracted in Tool Remapper, live tool selection telemetry will automatically update this pie chart.
                </span>
              </div>
            ) : (
              <div className="p-2.5 rounded-[var(--radius-sm)] bg-[rgba(var(--ov),0.02)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-tertiary)] flex items-center gap-2">
                <CheckCircle2 size={13} className="text-[var(--accent-primary)] shrink-0" />
                <span>
                  High app selection rates demonstrate optimal toolbox coverage and reduced setup time.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Admin Extractions Bar Graph Card */}
      <div className="aurora-card p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="p-2.5 bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)] rounded-[var(--radius-md)]">
                <BarChart3 size={20} />
              </span>
              <div>
                <h3 className="text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
                  Code Extractions by User
                  <span className="badge-warning text-[10px] py-0.5 px-2">
                    Admin Only
                  </span>
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Frequency of G-code extractions and time saved by each team member.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
              title="Configure time saved calculation baseline"
            >
              <Sliders size={13} />
              <span>Calculation Settings</span>
            </button>
          </div>
        </div>

        {/* Optional Baseline Calculation Settings Drawer */}
        {showSettings && (
          <div className="mb-6 p-4 glass-panel space-y-3 animate-in fade-in duration-200">
            <div className="flex items-center justify-between">
              <span className="section-label">
                Time Won Calculation Formula
              </span>
              <span className="text-xs font-mono text-[var(--green-500)] font-bold">
                Current: {Math.round(savedSeconds / 60 * 10) / 10} min saved / extraction
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Standard manual code modifications take <strong>5 to 6 minutes</strong> on average (e.g. 5.5 min). CNC Process Pro completes the remapping in <strong>30s to 1 min</strong> (e.g. 45s). Each extraction adds this saved duration to the total timer.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-medium text-[var(--text-tertiary)]">Baseline Presets:</span>
              {[
                { label: '4m 30s (5.0m manual - 30s app)', secs: 270 },
                { label: '4m 45s (5.5m manual - 45s app)', secs: 285 },
                { label: '5m 00s (6.0m manual - 60s app)', secs: 300 },
                { label: '5m 30s (6.0m manual - 30s app)', secs: 330 }
              ].map(preset => (
                <button
                  key={preset.secs}
                  onClick={() => setSavedSeconds(preset.secs)}
                  className={`px-3 py-1 text-xs font-medium rounded-[var(--radius-sm)] border transition cursor-pointer ${
                    savedSeconds === preset.secs
                      ? 'btn-primary py-1'
                      : 'badge-neutral hover:border-[var(--border-strong)]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {settingsError && <div className="badge-danger text-xs py-1.5 px-3">{settingsError}</div>}
          </div>
        )}

        {/* The Recharts Bar Chart */}
        <div className="h-72 w-full mt-2">
          {chartData.length === 0 || chartData.every(d => d.extractions === 0) ? (
            <div className="h-full flex flex-col items-center justify-center text-[var(--text-tertiary)] border border-dashed border-[var(--border-subtle)] rounded-[var(--radius-md)] p-6 text-center">
              <BarChart3 size={36} className="mb-2 opacity-30" />
              <p className="text-sm font-semibold text-[var(--text-secondary)]">
                No extractions recorded yet
              </p>
              <p className="text-xs text-[var(--text-tertiary)] max-w-sm mt-1">
                Whenever any user (Machinist or Admin) presses &quot;Extract Code&quot; in the Tool Remapper, their count and time won will appear on this graph in real time.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 15, right: 20, left: -10, bottom: 25 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(var(--ov),0.06)"
                />
                <XAxis
                  dataKey="username"
                  stroke="var(--text-tertiary)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(var(--ov),0.1)' }}
                  interval={0}
                  tick={{ fill: 'var(--text-secondary)', fontWeight: 500 }}
                />
                <YAxis
                  allowDecimals={false}
                  stroke="var(--text-tertiary)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(var(--ov),0.1)' }}
                  tick={{ fill: 'var(--text-secondary)' }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar
                  dataKey="extractions"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={54}
                >
                  {chartData.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={BAR_COLORS[index % BAR_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* User Breakdown Table / Leaderboard */}
        {chartData.length > 0 && (
          <div className="mt-8 border-t border-[var(--border-subtle)] pt-6">
            <h4 className="section-label mb-4 flex items-center gap-1.5 text-[var(--orange-500)]">
              <Award size={14} />
              Operator Productivity Breakdown
            </h4>

            <div className="divide-y divide-[var(--border-subtle)] overflow-hidden">
              {chartData.map((item, idx) => {
                const userWon = formatTimeWon(item.timeSavedSeconds);
                const percent = analytics.totalExtractions > 0
                  ? Math.round((item.extractions / analytics.totalExtractions) * 100)
                  : 0;

                return (
                  <div key={item.username} className="py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-[140px]">
                      <div className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--bg-input)] border border-[var(--border-subtle)] flex items-center justify-center font-bold text-xs text-[var(--text-secondary)]">
                        #{idx + 1}
                      </div>
                      <div>
                        <span className="font-semibold text-xs text-[var(--text-primary)] block">
                          {item.username}
                        </span>
                        <span className="text-[10px] text-[var(--text-tertiary)]">
                          {item.role || 'Operator'}
                        </span>
                      </div>
                    </div>

                    {/* Progress Bar Representation */}
                    <div className="flex-1 max-w-xs hidden md:block">
                      <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)] mb-1">
                        <span>Extractions share</span>
                        <span className="font-mono font-semibold text-[var(--text-secondary)]">{percent}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--bg-input)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.max(percent, 4)}%`,
                            backgroundColor: BAR_COLORS[idx % BAR_COLORS.length]
                          }}
                        />
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-6 text-right">
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)] block">Extractions</span>
                        <span className="font-bold text-xs text-[var(--text-primary)] font-mono">
                          {item.extractions}
                        </span>
                      </div>

                      <div className="min-w-[90px]">
                        <span className="text-[10px] text-[var(--text-tertiary)] block">Time Won</span>
                        <span className="font-bold text-xs text-[var(--green-500)] font-mono">
                          {userWon.formatted}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
