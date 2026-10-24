import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import TabSubMenu from './components/TabSubMenu';
import PhoneCheck from './components/PhoneCheck';
import { leavePhoneCheck, scannedMachine } from './lib/phoneCheck';
import DataManagement from './components/DataManagement';
import { TimeWonClock } from './components/TimeWonClock';
import { SyncStatus } from './components/SyncStatus';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { useUserSessionStorage } from './hooks/useUserSessionStorage';
import { useAuth } from './contexts/AuthContext';
import { SyncProvider, useSync } from './contexts/SyncContext';
import { MachineId, ToolChangeBlock, Tool } from './types';
import { Database, Wrench, History, Shield, LogOut, RefreshCw, PackagePlus, ClipboardCheck, Activity, KeyRound, ShieldCheck, AlertTriangle, X, Sun, Moon, Monitor, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { EASE_OUT, SPRING_PILL } from './lib/motion';
import { useT } from './i18n';

// Admin-only screen with the chart library: loaded on demand so operator PCs start faster.
const AdminExtractionAnalytics = lazy(() => import('./components/AdminExtractionAnalytics'));

type Tab = 'DATABASE' | 'REMAP' | 'ADMIN' | 'RECENT_CODES' | 'PART_ENTRY' | 'PART_REVIEW' | 'PREVENTIVE';

const DEFAULT_PROGRAM = '%\nO1000\nN14 T2 M6\nN15 (ST_10.00_050_G45_ALHS)\nN16 (DIAMETER 10.00 MM / LENGTH 50.00 MM)\nN20 G90 G54 G0 X0. Y0.\nN21 T3 M6\nN22 (MK_40.00_040_000_ALHS)\nN23 G0 Z50.\nN24 T5 M6\nN25 (SF_12.00_075_000_ALHS)\nN30 M30\n%';

export default function App() {
  const { user, status } = useAuth();
  const { t } = useT('app');
  // Opened from a machine's QR code: after signing in, only that machine's checks (phone screen).
  const [scanned, setScanned] = useState(scannedMachine);

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
      {scanned ? (
        <PhoneCheck
          key={user.id}
          machineId={scanned}
          onOpenApp={() => {
            leavePhoneCheck();
            setScanned(null);
          }}
        />
      ) : (
        <Workspace key={user.id} />
      )}
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
  // History (admins) opens from a button inside the Tool Remapper, in place of the remapper.
  const [remapView, setRemapView] = useState<'main' | 'history' | 'back'>('main');
  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    setRemapView('main');
  };

  // "Part without scan" → "Part review" (admins): a small menu that drops out of the tab on hover.
  const canReview = features.partTracking && user.role === 'ADMIN';
  const partTabRef = useRef<HTMLButtonElement>(null);
  const [partMenu, setPartMenu] = useState(false);
  const partMenuTimer = useRef<number | undefined>(undefined);
  const showPartMenu = () => {
    window.clearTimeout(partMenuTimer.current);
    if (canReview) setPartMenu(true);
  };
  // A short grace period lets the pointer travel from the tab into the menu.
  const hidePartMenuSoon = () => {
    window.clearTimeout(partMenuTimer.current);
    partMenuTimer.current = window.setTimeout(() => setPartMenu(false), 180);
  };
  useEffect(() => {
    if (!partMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPartMenu(false);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (partTabRef.current?.contains(target) || (target instanceof Element && target.closest('.tab-submenu'))) return;
      setPartMenu(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [partMenu]);
  useEffect(() => () => window.clearTimeout(partMenuTimer.current), []);
  const partTabActive = activeTab === 'PART_ENTRY' || activeTab === 'PART_REVIEW';
  useEffect(() => {
    document.querySelector('nav.app-tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

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
  const showMfaNudge = user.role === 'ADMIN' && !mfaEnabled && !weakPassword && !mfaNudgeHidden;

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
      <a href="#main-content" className="skip-link">{t('common:a11y.skipToContent')}</a>
      {/* Automatic 10-minute folder backup on the admin PC */}
      <AnimatePresence>
        {showPasswordModal && <ChangePasswordModal key="password" initialTab={showPasswordModal} onClose={() => setShowPasswordModal(false)} />}
      </AnimatePresence>

      {(weakPassword || showMfaNudge || connection === 'offline') && (
      <div role="region" aria-label={t('common:a11y.notices')}>
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

      {showMfaNudge && (
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
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-[var(--text-primary)] truncate">
                  CNC Process Pro
                </h1>
                {/* Hidden on phones (the wrapper: the badge's own display would win over "hidden"). */}
                <span className="hidden sm:inline-flex shrink-0">
                  <span className="badge-neutral text-[10px] py-0.5 px-2 tracking-wide font-mono">v6.0 AURORA</span>
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
          <div className="flex items-center gap-2 sm:gap-2.5 ml-auto relative z-10 min-w-0 max-w-full flex-wrap justify-end">
            {/* Server Sync Status Pill */}
            <SyncStatus />

            {/* Time Won Clock Widget */}
            <TimeWonClock
              compact={true}
              onClick={() => user.role === 'ADMIN' && openTab('ADMIN')}
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
        <nav aria-label={t('common:a11y.mainNav')} className="app-tabs glass-panel p-1.5 flex items-center gap-1 overflow-x-auto hide-scrollbar rounded-full max-w-full">
          {/* Tab 1: Tool Inventory */}
          <button
            onClick={() => openTab('DATABASE')}
            aria-current={activeTab === 'DATABASE' ? 'page' : undefined}
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
            onClick={() => openTab('REMAP')}
            aria-current={activeTab === 'REMAP' ? 'page' : undefined}
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

          {/* Tab 3: Recent Codes (MACHINIST) */}
          {user.role === 'MACHINIST' && (
            <button
              onClick={() => openTab('RECENT_CODES')}
            aria-current={activeTab === 'RECENT_CODES' ? 'page' : undefined}
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

          {/* Tab: Part without scan (Both Roles). For admins, "Part review" drops out of it on hover. */}
          {features.partTracking && (
            <button
              ref={partTabRef}
              aria-current={partTabActive ? 'page' : undefined}
              onClick={() => {
                // Touch screens have no hover: tapping the tab you are on opens its menu.
                if (canReview && partTabActive && !partMenu) {
                  setPartMenu(true);
                  return;
                }
                setPartMenu(false);
                openTab('PART_ENTRY');
              }}
              onPointerEnter={(e) => e.pointerType === 'mouse' && showPartMenu()}
              onPointerLeave={(e) => e.pointerType === 'mouse' && hidePartMenuSoon()}
              onKeyDown={(e) => {
                if (canReview && e.key === 'ArrowDown') {
                  e.preventDefault();
                  showPartMenu();
                }
              }}
              aria-haspopup={canReview ? 'menu' : undefined}
              aria-expanded={canReview ? partMenu : undefined}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                partTabActive
                  ? activeTab === 'PART_REVIEW'
                    ? 'text-[var(--green-500)]'
                    : 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <PackagePlus size={15} />
              <span>{t('tabs.partEntry')}</span>
              {activeTab === 'PART_REVIEW' && (
                <>
                  <ChevronRight size={12} className="-mx-1 opacity-60" />
                  <span>{t('tabs.partReview')}</span>
                </>
              )}
              {canReview && <ChevronDown size={12} className={`opacity-60 transition-transform duration-200 ${partMenu ? 'rotate-180' : ''}`} />}
              {partTabActive && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: activeTab === 'PART_REVIEW' ? 'rgba(22,163,74,0.12)' : 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
                <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className={`absolute bottom-0 left-3 right-3 h-[2.5px] rounded-full pointer-events-none ${activeTab === 'PART_REVIEW' ? 'bg-[var(--green-500)] shadow-[0_0_8px_var(--green-glow)]' : 'bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)]'}`} />
                </>
              )}
            </button>
          )}

          {/* Tab: Preventive actions (Both Roles) */}
          {features.preventive && (
            <button
              onClick={() => openTab('PREVENTIVE')}
            aria-current={activeTab === 'PREVENTIVE' ? 'page' : undefined}
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

          {/* Tab 4: Admin (ADMIN) */}
          {user.role === 'ADMIN' && (
            <button
              onClick={() => openTab('ADMIN')}
            aria-current={activeTab === 'ADMIN' ? 'page' : undefined}
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
        {canReview && (
          <TabSubMenu
            anchor={partTabRef.current}
            open={partMenu}
            label={t('subTabs.partEntryMenu')}
            onPointerEnter={showPartMenu}
            onPointerLeave={hidePartMenuSoon}
            items={[
              {
                id: 'entry',
                label: t('tabs.partEntry'),
                icon: <PackagePlus size={14} />,
                active: activeTab === 'PART_ENTRY',
                onSelect: () => {
                  setPartMenu(false);
                  openTab('PART_ENTRY');
                },
              },
              {
                id: 'review',
                label: t('tabs.partReview'),
                icon: <ClipboardCheck size={14} />,
                active: activeTab === 'PART_REVIEW',
                onSelect: () => {
                  setPartMenu(false);
                  openTab('PART_REVIEW');
                },
              },
            ]}
          />
        )}
      </div>

      {/* Main Content Area with Smooth AnimatePresence Dissolve Transition */}
      <main id="main-content" tabIndex={-1} className="flex-1 px-4 sm:px-6 pt-3 flex flex-col outline-none">
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
            {activeTab === 'REMAP' && remapView === 'history' && user.role === 'ADMIN' && (
              <motion.div
                key="remap-history"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
                className="flex-1 flex flex-col"
              >
                <div className="max-w-7xl mx-auto w-full mb-3">
                  <button type="button" className="btn-secondary text-xs py-2 px-3.5" onClick={() => setRemapView('back')}>
                    <ChevronLeft size={14} />
                    <span>{t('remapHistory.back')}</span>
                  </button>
                </div>
                <HistoryView />
              </motion.div>
            )}
            {activeTab === 'REMAP' && remapView !== 'history' && (
              <motion.div
                key="remap-main"
                initial={remapView === 'back' ? { opacity: 0, x: -24 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
                className="flex-1 flex flex-col"
              >
              <ToolRemapper 
                onOpenHistory={user.role === 'ADMIN' ? () => setRemapView('history') : undefined}
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
              </motion.div>
            )}
            {activeTab === 'RECENT_CODES' && user.role === 'MACHINIST' && (
              <RecentCodes />
            )}
            {activeTab === 'ADMIN' && user.role === 'ADMIN' && (
              <div className="flex flex-col space-y-6 max-w-5xl mx-auto w-full pb-16">
                <Suspense fallback={<div className="aurora-card p-10 text-center text-xs text-[var(--text-tertiary)]">{t('loadingAnalytics')}</div>}>
                  <AdminExtractionAnalytics />
                </Suspense>
                <UserManagement />
                <div className="w-full">
                  <MachineManager />
                </div>
                {currentRegion().id === 'ma' && (
                  <div className="w-full">
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
