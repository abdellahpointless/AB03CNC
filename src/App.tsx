import { lazy, Suspense, useEffect, useState } from 'react';
import { CHOOSE_COUNTRY_PATH, currentRegion, scopedKey } from './lib/instance';
import { Flag } from './components/Flag';
import MachineManager from './components/MachineManager';
import MasterAccountCard from './components/MasterAccountCard';
import ToolDatabase from './components/ToolDatabase';
import ToolRemapper from './components/ToolRemapper';
import HistoryView from './components/HistoryView';
import RecentCodes from './components/RecentCodes';
import Login from './components/Login';
import UserManagement from './components/UserManagement';
import PartWithoutScan from './components/PartWithoutScan';
import PartReview from './components/PartReview';
import PreventiveActions from './components/PreventiveActions';
import DataManagement from './components/DataManagement';
import { TimeWonClock } from './components/TimeWonClock';
import { SyncStatus } from './components/SyncStatus';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { useUserSessionStorage } from './hooks/useUserSessionStorage';
import { useAuth } from './contexts/AuthContext';
import { SyncProvider, useSync } from './contexts/SyncContext';
import { MachineId, ToolChangeBlock, Tool } from './types';
import { Database, Wrench, History, Shield, LogOut, RefreshCw, PackagePlus, ClipboardCheck, Activity, KeyRound, ShieldCheck, AlertTriangle, X, Sun, Moon, Monitor } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { EASE_OUT, SPRING_PILL } from './lib/motion';
import { useT } from './i18n';

// Admin-only screen with the chart library: loaded on demand so operator PCs start faster.
const AdminExtractionAnalytics = lazy(() => import('./components/AdminExtractionAnalytics'));

type Tab = 'DATABASE' | 'REMAP' | 'HISTORY' | 'ADMIN' | 'RECENT_CODES' | 'PART_ENTRY' | 'PART_REVIEW' | 'PREVENTIVE';

const DEFAULT_PROGRAM = '%\nO1000\nN14 T2 M6\nN15 (ST_10.00_050_G45_ALHS)\nN16 (DIAMETER 10.00 MM / LENGTH 50.00 MM)\nN20 G90 G54 G0 X0. Y0.\nN21 T3 M6\nN22 (MK_40.00_040_000_ALHS)\nN23 G0 Z50.\nN24 T5 M6\nN25 (SF_12.00_075_000_ALHS)\nN30 M30\n%';

export default function App() {
  const { user, status } = useAuth();
  const { t } = useT('app');

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--text-tertiary)] gap-2 text-sm">
        <RefreshCw size={16} className="animate-spin text-[var(--accent-primary)]" />
        <span>{t('loading')}</span>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <SyncProvider>
      <Workspace key={user.id} />
    </SyncProvider>
  );
}

function Workspace() {
  const { t } = useT('app');
  const { user: authUser, logout, weakPassword, dismissWeakPassword, mfaEnabled } = useAuth();
  const user = authUser!;
  const { refreshNow, connection, features } = useSync();
  const [activeTab, setActiveTab] = useState<Tab>('REMAP');
  // A master admin switched off the feature that is open on this screen: back to the remapper.
  useEffect(() => {
    if ((!features.partTracking && (activeTab === 'PART_ENTRY' || activeTab === 'PART_REVIEW')) || (!features.preventive && activeTab === 'PREVENTIVE')) {
      setActiveTab('REMAP');
    }
  }, [features, activeTab]);
  const [showPasswordModal, setShowPasswordModal] = useState<false | 'password' | 'mfa'>(false);
  const [mfaNudgeHidden, setMfaNudgeHidden] = useState(() => {
    try {
      return sessionStorage.getItem(scopedKey('cnc-mfa-nudge-hidden')) === '1';
    } catch {
      return false;
    }
  });
  const hideMfaNudge = () => {
    setMfaNudgeHidden(true);
    try {
      sessionStorage.setItem(scopedKey('cnc-mfa-nudge-hidden'), '1');
    } catch {
      /* storage unavailable */
    }
  };
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Machine selection is strictly isolated per user session - changes never affect other users
  const [databaseMachine, setDatabaseMachine] = useUserSessionStorage<MachineId>(user.username, 'selected-db-machine', 'HAAS-1');
  const [remapperMachine, setRemapperMachine] = useUserSessionStorage<MachineId>(user.username, 'selected-remap-machine', 'HAAS-1');

  // Uploaded program & analysis is strictly isolated per user session
  const [sourceCodeRaw, setSourceCode] = useUserSessionStorage<string>(user.username, 'uploaded-source-code', DEFAULT_PROGRAM);
  const sourceCode: string = typeof sourceCodeRaw === 'string' ? sourceCodeRaw : DEFAULT_PROGRAM;

  const [fileNameRaw, setFileName] = useUserSessionStorage<string>(user.username, 'uploaded-filename', 'program.nc');
  const fileName: string = typeof fileNameRaw === 'string' ? fileNameRaw : 'program.nc';
  const [outputCode, setOutputCode] = useState<string>('');
  const [blocks, setBlocks] = useState<ToolChangeBlock[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [detectedMat, setDetectedMat] = useState<string | undefined>(undefined);
  const [resolutions, setResolutions] = useState<Record<string, Tool>>({});
  const [analyzedSignature, setAnalyzedSignature] = useState<string>('');

  const handleNavigateToDatabase = (machine: MachineId) => {
    setDatabaseMachine(machine);
    setActiveTab('DATABASE');
  };

  const handleGlobalRefresh = async () => {
    setIsRefreshing(true);
    await refreshNow();
    setIsRefreshing(false);
  };

  return (
    <div className="min-h-screen flex flex-col relative pb-8">
      {/* Automatic 10-minute folder backup on the admin PC */}
      <AnimatePresence>
        {showPasswordModal && <ChangePasswordModal key="password" initialTab={showPasswordModal} onClose={() => setShowPasswordModal(false)} />}
      </AnimatePresence>

      {weakPassword && (
        <div className="px-4 sm:px-6 pt-3 relative z-30">
          <div className="p-3 rounded-[var(--radius-md)] bg-[var(--orange-500)]/15 border border-[var(--orange-500)]/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--orange-500)] font-semibold">
              <AlertTriangle size={16} className="shrink-0" />
              <span>
                {t('banners.weakPassword', { min: user.role === 'ADMIN' ? 10 : 8 })}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setShowPasswordModal('password')} className="btn-warning text-xs py-1 px-3">
                <KeyRound size={13} />
                <span>{t('security.changePassword')}</span>
              </button>
              <button onClick={dismissWeakPassword} className="btn-icon w-7 h-7" title={t('common:actions.dismiss')}>
                <X size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {user.role === 'ADMIN' && !mfaEnabled && !weakPassword && !mfaNudgeHidden && (
        <div className="px-4 sm:px-6 pt-3 relative z-30">
          <div className="p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold">
              <ShieldCheck size={16} className="shrink-0 text-[var(--blue-500)]" />
              <span>{t('banners.mfaNudge')}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setShowPasswordModal('mfa')} className="btn-primary text-xs py-1 px-3">
                <span>{t('banners.turnOn')}</span>
              </button>
              <button onClick={hideMfaNudge} className="btn-icon w-7 h-7" title={t('common:actions.later')}>
                <X size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {connection === 'offline' && (
        <div className="px-4 sm:px-6 pt-3 relative z-30">
          <div className="p-2.5 rounded-[var(--radius-md)] bg-[var(--orange-500)]/10 border border-[var(--orange-500)]/30 text-xs text-[var(--orange-500)] flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{t('banners.offline')}</span>
          </div>
        </div>
      )}

      {/* Aurora Glass Header (Section 4: App Shell / Header) */}
      <div className="px-4 sm:px-6 pt-3 sm:pt-4 relative z-20">
        <header className="glass-panel px-4 sm:px-5 py-2.5 sm:py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 relative">
          {/* Left: Rounded-square logo mark + text + badge + subtitle */}
          <div className="flex items-center gap-3 relative z-10 shrink min-w-0">
            <div className="relative shrink-0">
              <div 
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--blue-500)] to-violet-700 flex items-center justify-center text-white font-mono font-bold text-sm sm:text-base shadow-[0_4px_16px_rgba(59,111,212,0.4)] cursor-pointer select-none"
                title={t('header.syncTitle')}
                onClick={handleGlobalRefresh}
              >
                //
              </div>
              {/* Online indicator dot pinned to corner */}
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-[var(--green-500)] border-2 border-[var(--bg-panel)] shadow-[0_0_6px_var(--green-glow)] shrink-0 pointer-events-none" />
            </div>

            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base sm:text-lg font-bold tracking-tight text-[var(--text-primary)] truncate">
                  CNC Process Pro
                </span>
                <span className="badge-neutral text-[10px] py-0.5 px-2 tracking-wide font-mono shrink-0">
                  v6.0 AURORA
                </span>
                {/* Country of this instance; click to go back to the country picker. */}
                <a
                  href={CHOOSE_COUNTRY_PATH}
                  className="shrink-0 inline-flex items-center rounded-[3px] ring-1 ring-[var(--border-subtle)] hover:ring-[var(--blue-500)] transition"
                  title={`${t(`common:country.${currentRegion().id}`)} · ${t('common:actions.changeCountry')}`}
                  aria-label={t('common:actions.changeCountry')}
                >
                  <Flag country={currentRegion().id} className="w-6 h-4 rounded-[3px] block" />
                </a>
              </div>
              <span className="text-[11px] sm:text-[12px] text-[var(--text-secondary)] font-normal hidden sm:block truncate">
                {t('header.subtitle')}
              </span>
            </div>
          </div>

          {/* Center-Right & Right Controls */}
          <div className="flex items-center gap-2 sm:gap-2.5 ml-auto relative z-10 shrink-0 flex-wrap justify-end">
            {/* Server Sync Status Pill */}
            <SyncStatus />

            {/* Time Won Clock Widget */}
            <TimeWonClock
              compact={true}
              onClick={() => user.role === 'ADMIN' && setActiveTab('ADMIN')}
            />

            {/* User / Role Chip: circular avatar + stacked two-line name/role inside bordered pill */}
            <div className="flex items-center gap-2 py-1 px-2.5 sm:px-3 rounded-full border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.04)] shrink-0">
              <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gradient-to-br from-[var(--blue-500)] to-[var(--blue-600)] flex items-center justify-center text-white font-bold text-xs uppercase shadow-xs">
                {user.username.slice(0, 2)}
              </div>
              <div className="flex flex-col text-left leading-none pr-1">
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {user.username}
                </span>
                <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-semibold text-[var(--text-tertiary)] mt-0.5">
                  {t(`common:role.${user.role}`)}
                </span>
              </div>
            </div>

            {/* Circular Icon Buttons: Change Password, Refresh Sync, Sign Out */}
            <button 
              onClick={() => setShowPasswordModal('password')} 
              className="btn-icon" 
              title={t('header.securityTitle')}
            >
              <KeyRound size={15} />
            </button>

            <ThemeToggle />

            <button 
              onClick={handleGlobalRefresh} 
              className="btn-icon" 
              title={t('header.syncNow')}
            >
              <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} />
            </button>

            <button 
              onClick={logout} 
              className="btn-icon btn-icon-danger" 
              title={t('header.signOut')}
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>
      </div>

      {/* Tab Bar: Pill-shaped Glass Container (Section 8: Tabs) */}
      <div className="px-4 sm:px-6 pt-2.5 sm:pt-3 relative z-10">
        <nav className="glass-panel p-1.5 flex items-center gap-1 overflow-x-auto hide-scrollbar rounded-full max-w-full">
          {/* Tab 1: Tool Inventory */}
          <button
            onClick={() => setActiveTab('DATABASE')}
            className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
              activeTab === 'DATABASE'
                ? 'text-[var(--accent-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
            }`}
          >
            <Database size={15} />
            <span>{t('tabs.toolInventory')}</span>
            {activeTab === 'DATABASE' && (
              <>
              <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)] rounded-full pointer-events-none" />
              </>
            )}
          </button>

          {/* Tab 2: Tool Remapper */}
          <button
            onClick={() => setActiveTab('REMAP')}
            className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
              activeTab === 'REMAP'
                ? 'text-[var(--accent-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
            }`}
          >
            <Wrench size={15} />
            <span>{t('tabs.remapper')}</span>
            {activeTab === 'REMAP' && (
              <>
              <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)] rounded-full pointer-events-none" />
              </>
            )}
          </button>

          {/* Tab 3: History (ADMIN) */}
          {user.role === 'ADMIN' && (
            <button
              onClick={() => setActiveTab('HISTORY')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'HISTORY'
                  ? 'text-[var(--orange-500)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <History size={15} />
              <span>{t('tabs.history')}</span>
              {activeTab === 'HISTORY' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(224,138,77,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--orange-500)] shadow-[0_0_10px_var(--orange-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}

          {/* Tab 3: Recent Codes (MACHINIST) */}
          {user.role === 'MACHINIST' && (
            <button
              onClick={() => setActiveTab('RECENT_CODES')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'RECENT_CODES'
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <History size={15} />
              <span>{t('tabs.recentCodes')}</span>
              {activeTab === 'RECENT_CODES' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_8px_var(--accent-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}

          {/* Tab: Part without scan (Both Roles) */}
          {features.partTracking && (
            <button
              onClick={() => setActiveTab('PART_ENTRY')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'PART_ENTRY'
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <PackagePlus size={15} />
              <span>{t('tabs.partEntry')}</span>
              {activeTab === 'PART_ENTRY' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
                <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}

          {/* Tab: Preventive actions (Both Roles) */}
          {features.preventive && (
            <button
              onClick={() => setActiveTab('PREVENTIVE')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'PREVENTIVE'
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <Activity size={15} />
              <span>{t('tabs.preventive')}</span>
              {activeTab === 'PREVENTIVE' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
                <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}

          {/* Tab: Part Review (ADMIN) */}
          {features.partTracking && user.role === 'ADMIN' && (
            <button
              onClick={() => setActiveTab('PART_REVIEW')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'PART_REVIEW'
                  ? 'text-[var(--green-500)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <ClipboardCheck size={15} />
              <span>{t('tabs.partReview')}</span>
              {activeTab === 'PART_REVIEW' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(22,163,74,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--green-500)] shadow-[0_0_8px_var(--green-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}

          {/* Tab 4: Admin (ADMIN) */}
          {user.role === 'ADMIN' && (
            <button
              onClick={() => setActiveTab('ADMIN')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                activeTab === 'ADMIN'
                  ? 'text-[var(--green-500)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <Shield size={15} />
              <span>{t('tabs.admin')}</span>
              {activeTab === 'ADMIN' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(22,163,74,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--green-500)] shadow-[0_0_8px_var(--green-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}
        </nav>
      </div>

      {/* Main Content Area with Smooth AnimatePresence Dissolve Transition */}
      <main className="flex-1 px-4 sm:px-6 pt-3 flex flex-col">
        {/* Tabs are switched many times a day: the new view appears at once and only fades in
            briefly (no exit wait, which used to add ~180 ms before every tab change). */}
          <motion.div 
            key={activeTab}
            initial={{ opacity: 0, y: 10, scale: 0.99, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
            transition={{ type: 'spring', duration: 0.4, bounce: 0.12 }}
            className="tab-view flex-1 flex flex-col"
          >
            {activeTab === 'DATABASE' && (
              <ToolDatabase 
                selectedMachine={databaseMachine}
                setSelectedMachine={setDatabaseMachine}
              />
            )}
            {activeTab === 'REMAP' && (
              <ToolRemapper 
                onNavigateToDatabase={handleNavigateToDatabase}
                selectedMachine={remapperMachine}
                setSelectedMachine={setRemapperMachine}
                sourceCode={sourceCode}
                setSourceCode={setSourceCode}
                fileName={fileName}
                setFileName={setFileName}
                outputCode={outputCode}
                setOutputCode={setOutputCode}
                blocks={blocks}
                setBlocks={setBlocks}
                lines={lines}
                setLines={setLines}
                detectedMat={detectedMat}
                setDetectedMat={setDetectedMat}
                resolutions={resolutions}
                setResolutions={setResolutions}
                analyzedSignature={analyzedSignature}
                setAnalyzedSignature={setAnalyzedSignature}
              />
            )}
            {activeTab === 'HISTORY' && user.role === 'ADMIN' && (
              <HistoryView />
            )}
            {activeTab === 'RECENT_CODES' && user.role === 'MACHINIST' && (
              <RecentCodes />
            )}
            {activeTab === 'ADMIN' && user.role === 'ADMIN' && (
              <div className="flex flex-col space-y-6 max-w-6xl mx-auto w-full pb-16">
                <Suspense fallback={<div className="aurora-card p-10 text-center text-xs text-[var(--text-tertiary)]">{t('loadingAnalytics')}</div>}>
                  <AdminExtractionAnalytics />
                </Suspense>
                <UserManagement />
                <div className="max-w-4xl mx-auto w-full">
                  <MachineManager />
                </div>
                {currentRegion().id === 'ma' && (
                  <div className="max-w-4xl mx-auto w-full">
                    <MasterAccountCard />
                  </div>
                )}
                <div className="aurora-card aurora-card-static p-6">
                  <DataManagement />
                </div>
              </div>
            )}
            {activeTab === 'PART_ENTRY' && features.partTracking && (
              <PartWithoutScan />
            )}
            {activeTab === 'PREVENTIVE' && features.preventive && (
              <PreventiveActions />
            )}
            {activeTab === 'PART_REVIEW' && features.partTracking && user.role === 'ADMIN' && (
              <PartReview />
            )}
          </motion.div>
      </main>
    </div>
  );
}

const THEME_ORDER: ThemeMode[] = ['dark', 'light', 'system'];

function ThemeToggle() {
  const { t } = useT('app');
  const { mode, setMode } = useTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  return (
    <button
      onClick={() => setMode(next)}
      className="btn-icon"
      title={t('theme.title', { current: t(`theme.label.${mode}`), next: t(`theme.nextLabel.${next}`) })}
      aria-label={t('theme.aria', { mode: t(`theme.label.${mode}`) })}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={mode}
          className="flex"
          initial={{ opacity: 0, rotate: -45, scale: 0.8 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 45, scale: 0.8 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        >
          <Icon size={15} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
