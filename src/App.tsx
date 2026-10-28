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
import PreventiveReports from './components/PreventiveReports';
import CalesStock from './components/CalesStock';
import TabSubMenu from './components/TabSubMenu';
import PhoneCheck from './components/PhoneCheck';
import { leavePhoneCheck, scannedMachine } from './lib/phoneCheck';
import DataManagement from './components/DataManagement';
import { TimeWonClock } from './components/TimeWonClock';
import { SyncStatus } from './components/SyncStatus';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { AccountMenu } from './components/AccountMenu';
import { useUserSessionStorage } from './hooks/useUserSessionStorage';
import { useAuth } from './contexts/AuthContext';
import { SyncProvider, useSync } from './contexts/SyncContext';
import { MachineId, ToolChangeBlock, Tool } from './types';
import { fetchCalesStock, fetchRequired, type RequiredItem } from './lib/fleet';
import { Database, Wrench, History, Shield, RefreshCw, PackagePlus, ClipboardCheck, ClipboardX, Boxes, Activity, KeyRound, ShieldCheck, AlertTriangle, X, ChevronDown, ChevronLeft, ChevronRight, Lock, BellRing } from 'lucide-react';
import { ring, unlockSound } from './lib/alarm';
import { fmtTime } from './i18n/format';
import { motion, AnimatePresence } from 'motion/react';
import { SPRING_PILL } from './lib/motion';
import { useT } from './i18n';

// Admin-only screen with the chart library: loaded on demand so operator PCs start faster.
const AdminExtractionAnalytics = lazy(() => import('./components/AdminExtractionAnalytics'));

type Tab = 'DATABASE' | 'REMAP' | 'ADMIN' | 'RECENT_CODES' | 'PART_ENTRY' | 'PART_REVIEW' | 'PREVENTIVE' | 'PREVENTIVE_REPORTS' | 'PREVENTIVE_CALES';
const TAB_NAME = {
  DATABASE: 'tabs.toolInventory',
  REMAP: 'tabs.remapper',
  ADMIN: 'tabs.admin',
  RECENT_CODES: 'tabs.recentCodes',
  PART_ENTRY: 'tabs.partEntry',
  PART_REVIEW: 'tabs.partReview',
  PREVENTIVE: 'tabs.preventive',
  PREVENTIVE_REPORTS: 'tabs.preventiveReports',
  PREVENTIVE_CALES: 'tabs.preventiveCales',
} as const;

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
  const { user: authUser, weakPassword, dismissWeakPassword, mfaEnabled } = useAuth();
  const user = authUser!;
  const { refreshNow, connection, features, versions, machines } = useSync();
  const [activeTab, setActiveTab] = useState<Tab>('REMAP');

  // Workflow gate, not a security boundary: the server says what is left for me (GET /machines/required)
  // but does not block its other routes. Until someone who looks after a machine has done their checks
  // and this shift's cales box, only Preventive actions is shown. Admins are never locked; a failed
  // request never locks anyone.
  const [required, setRequired] = useState<RequiredItem[]>([]);
  // End of shift tasks still to do, in the last 45 minutes of the shift (they never lock).
  const [ending, setEnding] = useState<RequiredItem[]>([]);
  const [endsAt, setEndsAt] = useState(0);
  const locked = features.preventive && features.shiftChecks && required.length > 0;
  useEffect(() => {
    if (!features.preventive || !features.shiftChecks || user.role === 'ADMIN') {
      setRequired([]);
      setEnding([]);
      return;
    }
    let alive = true;
    const ask = () =>
      fetchRequired().then((r) => {
        if (!alive) return;
        setRequired(r.locked ? r.items : []);
        setEnding(r.ending);
        setEndsAt(r.endsAt);
      }, () => undefined);
    ask();
    const id = window.setInterval(ask, 60_000); // a new shift or period starts by the clock
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [features.preventive, features.shiftChecks, user.role, versions.machines]);
  useEffect(() => {
    if (locked && activeTab !== 'PREVENTIVE') setActiveTab('PREVENTIVE');
  }, [locked, activeTab]);
  const left = new Map<string, { checks: number; cales: boolean }>();
  for (const i of required) {
    const m = left.get(i.machineId) ?? { checks: 0, cales: false };
    if (i.kind === 'CHECK') m.checks++;
    else m.cales = true;
    left.set(i.machineId, m);
  }
  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const endLeft = new Map<string, number>();
  for (const i of ending) endLeft.set(i.machineId, (endLeft.get(i.machineId) ?? 0) + 1);
  const endList = [...endLeft].map(([id, n]) => `${nameOf(id)}: ${t('ending.tasks', { count: n })}`).join(' · ');

  // Browsers ask before showing PC notifications, and let a page ring only after a click: both on the first click.
  const pending = required.length > 0 || ending.length > 0;
  useEffect(() => {
    if (!pending) return;
    const onDown = () => {
      unlockSound();
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    };
    window.addEventListener('pointerdown', onDown, { once: true });
    return () => window.removeEventListener('pointerdown', onDown);
  }, [pending]);

  // End of shift: one notification on the PC (outside the browser), then the PC rings every few seconds
  // until the person is in the app, on Preventive actions. shortcut: needs the app open in a browser
  // tab (it may be in the background); a closed browser would need web push.
  const tabRef = useRef(activeTab);
  tabRef.current = activeTab;
  const notified = useRef(0);
  const endBody = t('ending.body', { time: fmtTime(endsAt), list: endList });
  useEffect(() => {
    if (!ending.length) return;
    if (notified.current !== endsAt && 'Notification' in window && Notification.permission === 'granted') {
      notified.current = endsAt;
      const n = new Notification(t('ending.title'), { body: endBody, tag: 'cnc-shift-end', requireInteraction: true });
      n.onclick = () => {
        window.focus();
        setActiveTab('PREVENTIVE');
        n.close();
      };
    }
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || tabRef.current !== 'PREVENTIVE') ring();
    }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ending.length, endsAt]);
  // Admins: open requests for new cales, shown as a count on the Admin tab.
  const calesOn = features.preventive && features.shiftChecks && user.role === 'ADMIN';
  const [calesAsks, setCalesAsks] = useState(0);
  useEffect(() => {
    if (!calesOn) {
      setCalesAsks(0);
      return;
    }
    let alive = true;
    fetchCalesStock().then((d) => alive && setCalesAsks(d.requests.length), () => undefined);
    return () => {
      alive = false;
    };
  }, [calesOn, versions.machines]);

  // A master admin switched off the feature that is open on this screen: back to the remapper.
  useEffect(() => {
    if ((!features.partTracking && (activeTab === 'PART_ENTRY' || activeTab === 'PART_REVIEW')) || (!features.preventive && (activeTab === 'PREVENTIVE' || activeTab === 'PREVENTIVE_REPORTS')) || (!calesOn && activeTab === 'PREVENTIVE_CALES')) {
      setActiveTab('REMAP');
    }
  }, [features, activeTab, calesOn]);
  // History (admins) opens from a button inside the Tool Remapper, in place of the remapper.
  const [remapView, setRemapView] = useState<'main' | 'history' | 'back'>('main');
  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    setRemapView('main');
  };
  // The browser tab and history name the screen that is open.
  const pageName = activeTab === 'REMAP' && remapView === 'history' ? t('tabs.history') : t(TAB_NAME[activeTab]);
  useEffect(() => {
    document.title = `${pageName} · CNC Process Pro`;
  }, [pageName]);

  // "Part without scan" → "Part review" and "Preventive actions" → "Reports" (admins): small menus
  // that drop out of the tab on hover, or on a second tap of the tab you are on.
  const canReview = features.partTracking && user.role === 'ADMIN';
  const partMenu = useTabMenu(canReview);
  const canReports = features.preventive && user.role === 'ADMIN';
  const prevMenu = useTabMenu(canReports);
  const prevTabActive = activeTab === 'PREVENTIVE' || activeTab === 'PREVENTIVE_REPORTS' || activeTab === 'PREVENTIVE_CALES';
  const partTabActive = activeTab === 'PART_ENTRY' || activeTab === 'PART_REVIEW';
  useEffect(() => {
    document.querySelector('nav.app-tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);
  // Which edges of the tab bar hide more tabs (the CSS fades that edge).
  const tabsRef = useRef<HTMLElement>(null);
  const [moreTabs, setMoreTabs] = useState<'left' | 'right' | 'both' | undefined>();
  const measureTabs = () => {
    const n = tabsRef.current;
    if (!n) return;
    const l = n.scrollLeft > 2;
    const r = n.scrollLeft + n.clientWidth < n.scrollWidth - 2;
    setMoreTabs(l && r ? 'both' : l ? 'left' : r ? 'right' : undefined);
  };
  useEffect(() => {
    measureTabs();
    window.addEventListener('resize', measureTabs);
    return () => window.removeEventListener('resize', measureTabs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, locked, features]);

  const [showPasswordModal, setShowPasswordModal] = useState<false | 'password' | 'mfa'>(false);
  // Closed, the two-step sign-in reminder stays away for 30 days on this device (it was back at every visit).
  const [mfaNudgeHidden, setMfaNudgeHidden] = useState(() => {
    try {
      return Date.now() - Number(localStorage.getItem(scopedKey('cnc-mfa-nudge-hidden-at')) || 0) < 30 * 86_400_000;
    } catch {
      return false;
    }
  });
  const hideMfaNudge = () => {
    setMfaNudgeHidden(true);
    try {
      localStorage.setItem(scopedKey('cnc-mfa-nudge-hidden-at'), String(Date.now()));
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
            <div className="flex items-center gap-2 text-[var(--orange-text)] font-semibold">
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
          <div className="py-2 px-3 sm:p-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.1)] border border-[var(--blue-500)]/30 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold min-w-0">
              <ShieldCheck size={16} className="shrink-0 text-[var(--blue-text)]" />
              <span className="sm:hidden">{t('banners.mfaNudgeShort')}</span>
              <span className="hidden sm:inline">{t('banners.mfaNudge')}</span>
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
          <div className="p-2.5 rounded-[var(--radius-md)] bg-[var(--orange-500)]/10 border border-[var(--orange-500)]/30 text-xs text-[var(--orange-text)] flex items-center gap-2">
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
                {/* Country of this instance; click to go back to the country picker. */}
                <a
                  href={CHOOSE_COUNTRY_PATH}
                  className="group shrink-0 inline-flex items-center p-1 -m-1"
                  title={`${t(`common:country.${currentRegion().id}`)} · ${t('common:actions.changeCountry')}`}
                  aria-label={t('common:actions.changeCountry')}
                >
                  <Flag country={currentRegion().id} className="w-6 h-4 rounded-[3px] block ring-1 ring-[var(--border-subtle)] group-hover:ring-[var(--blue-500)] transition" />
                </a>
              </div>
              <span className="text-xs sm:text-[12px] text-[var(--text-secondary)] font-normal hidden sm:block truncate">
                {t('header.subtitle')}
              </span>
            </div>
          </div>

          {/* Center-Right & Right Controls */}
          <div className="flex items-center gap-2 sm:gap-2.5 ml-auto relative z-10 min-w-0 max-w-full flex-wrap justify-end">
            {/* Phones: the sync pill and the time saved move into the account menu (no room in one row). */}
            <div className="hidden sm:flex items-center gap-2 sm:gap-2.5">
              <SyncStatus />
              <TimeWonClock compact={true} onClick={() => user.role === 'ADMIN' && openTab('ADMIN')} />
            </div>

            <AccountMenu
              onSecurity={() => setShowPasswordModal('password')}
              onSync={handleGlobalRefresh}
              syncing={isRefreshing}
              onTimeSaved={() => user.role === 'ADMIN' && openTab('ADMIN')}
            />

          </div>
        </header>
      </div>

      {/* Tab Bar: Pill-shaped Glass Container (Section 8: Tabs) */}
      <div className="px-4 sm:px-6 pt-2.5 sm:pt-3 relative z-10">
        {ending.length > 0 && (
          <div role="alert" className="glass-panel rounded-[var(--radius-lg)] px-4 py-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs border border-[var(--rose-500)]/40">
            <span className="flex items-center gap-2 font-semibold text-[var(--rose-500)]">
              <BellRing size={15} className="shift-bell" /> {t('ending.banner', { time: fmtTime(endsAt) })}
            </span>
            <span className="flex flex-wrap gap-1.5">
              {[...endLeft].map(([id, n]) => (
                <span key={id} className="badge-danger">
                  {nameOf(id)}: {t('ending.tasks', { count: n })}
                </span>
              ))}
            </span>
            {activeTab !== 'PREVENTIVE' && (
              <button type="button" className="btn-danger text-xs py-1.5 px-3 sm:ml-auto" onClick={() => openTab('PREVENTIVE')}>
                {t('ending.doNow')}
              </button>
            )}
          </div>
        )}
        {locked ? (
          <div role="status" className="glass-panel rounded-[var(--radius-lg)] px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="flex items-center gap-2 font-semibold text-[var(--orange-text)]">
              <Lock size={15} /> {t('lock.title')}
            </span>
            <span className="text-[var(--text-secondary)]">{t('lock.help')}</span>
            <span className="flex flex-wrap gap-1.5">
              {[...left].map(([id, l]) => (
                <span key={id} className="badge-warning">
                  {nameOf(id)}:{' '}
                  {[l.checks ? t('lock.checks', { count: l.checks }) : '', l.cales ? t('lock.cales') : ''].filter(Boolean).join(' · ')}
                </span>
              ))}
            </span>
          </div>
        ) : (
        <nav ref={tabsRef} onScroll={measureTabs} data-more={moreTabs} aria-label={t('common:a11y.mainNav')} className="app-tabs glass-panel p-1.5 flex items-center gap-1 overflow-x-auto hide-scrollbar rounded-full max-w-full">
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
              ref={partMenu.ref}
              aria-current={partTabActive ? 'page' : undefined}
              onClick={() => {
                // Touch screens have no hover: tapping the tab you are on opens its menu.
                if (canReview && partTabActive && !partMenu.open) {
                  partMenu.setOpen(true);
                  return;
                }
                partMenu.setOpen(false);
                openTab('PART_ENTRY');
              }}
              onPointerEnter={(e) => e.pointerType === 'mouse' && partMenu.show()}
              onPointerLeave={(e) => e.pointerType === 'mouse' && partMenu.hideSoon()}
              onKeyDown={(e) => {
                if (canReview && e.key === 'ArrowDown') {
                  e.preventDefault();
                  partMenu.show();
                }
              }}
              aria-haspopup={canReview ? 'menu' : undefined}
              aria-expanded={canReview ? partMenu.open : undefined}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                partTabActive
                  ? 'text-[var(--accent-primary)]'
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
              {canReview && <ChevronDown size={12} className={`opacity-60 transition-transform duration-200 ${partMenu.open ? 'rotate-180' : ''}`} />}
              {partTabActive && (
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
              ref={prevMenu.ref}
              aria-current={prevTabActive ? 'page' : undefined}
              onClick={() => {
                // Touch screens have no hover: tapping the tab you are on opens its menu.
                if (canReports && prevTabActive && !prevMenu.open) {
                  prevMenu.setOpen(true);
                  return;
                }
                prevMenu.setOpen(false);
                openTab('PREVENTIVE');
              }}
              onPointerEnter={(e) => e.pointerType === 'mouse' && prevMenu.show()}
              onPointerLeave={(e) => e.pointerType === 'mouse' && prevMenu.hideSoon()}
              onKeyDown={(e) => {
                if (canReports && e.key === 'ArrowDown') {
                  e.preventDefault();
                  prevMenu.show();
                }
              }}
              aria-haspopup={canReports ? 'menu' : undefined}
              aria-expanded={canReports ? prevMenu.open : undefined}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                prevTabActive
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <Activity size={15} />
              <span>{t('tabs.preventive')}</span>
              {(activeTab === 'PREVENTIVE_REPORTS' || activeTab === 'PREVENTIVE_CALES') && (
                <>
                  <ChevronRight size={12} className="-mx-1 opacity-60" />
                  <span>{t(TAB_NAME[activeTab])}</span>
                </>
              )}
              {calesAsks > 0 && (
                <span className="badge-danger py-0 px-1.5 text-xs">
                  {calesAsks}
                  <span className="sr-only"> {t('adminNav.calesRequests', { count: calesAsks })}</span>
                </span>
              )}
              {canReports && <ChevronDown size={12} className={`opacity-60 transition-transform duration-200 ${prevMenu.open ? 'rotate-180' : ''}`} />}
              {prevTabActive && (
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
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.04)]'
              }`}
            >
              <Shield size={15} />
              <span>{t('tabs.admin')}</span>
              {activeTab === 'ADMIN' && (
                <>
                <motion.span layoutId="tab-pill" className="tab-pill" style={{ background: 'rgba(59,111,212,0.12)' }} transition={SPRING_PILL} />
              <motion.span layoutId="tab-underline" transition={SPRING_PILL} style={{ position: 'absolute' }} className="absolute bottom-0 left-3 right-3 h-[2.5px] bg-[var(--accent-primary)] shadow-[0_0_10px_var(--accent-glow)] rounded-full pointer-events-none" />
                </>
              )}
            </button>
          )}
        </nav>
        )}
        {canReview && (
          <TabSubMenu
            anchor={partMenu.ref.current}
            open={partMenu.open}
            label={t('subTabs.partEntryMenu')}
            onPointerEnter={partMenu.show}
            onPointerLeave={partMenu.hideSoon}
            items={[
              {
                id: 'entry',
                label: t('tabs.partEntry'),
                icon: <PackagePlus size={14} />,
                active: activeTab === 'PART_ENTRY',
                onSelect: () => {
                  partMenu.setOpen(false);
                  openTab('PART_ENTRY');
                },
              },
              {
                id: 'review',
                label: t('tabs.partReview'),
                icon: <ClipboardCheck size={14} />,
                active: activeTab === 'PART_REVIEW',
                onSelect: () => {
                  partMenu.setOpen(false);
                  openTab('PART_REVIEW');
                },
              },
            ]}
          />
        )}
        {canReports && (
          <TabSubMenu
            anchor={prevMenu.ref.current}
            open={prevMenu.open}
            label={t('subTabs.preventiveMenu')}
            onPointerEnter={prevMenu.show}
            onPointerLeave={prevMenu.hideSoon}
            items={[
              {
                id: 'machines',
                label: t('tabs.preventive'),
                icon: <Activity size={14} />,
                active: activeTab === 'PREVENTIVE',
                onSelect: () => {
                  prevMenu.setOpen(false);
                  openTab('PREVENTIVE');
                },
              },
              {
                id: 'reports',
                label: t('tabs.preventiveReports'),
                icon: <ClipboardX size={14} />,
                active: activeTab === 'PREVENTIVE_REPORTS',
                onSelect: () => {
                  prevMenu.setOpen(false);
                  openTab('PREVENTIVE_REPORTS');
                },
              },
              ...(calesOn
                ? [
                    {
                      id: 'cales',
                      label: calesAsks ? `${t('tabs.preventiveCales')} (${calesAsks})` : t('tabs.preventiveCales'),
                      icon: <Boxes size={14} />,
                      active: activeTab === 'PREVENTIVE_CALES',
                      onSelect: () => {
                        prevMenu.setOpen(false);
                        openTab('PREVENTIVE_CALES');
                      },
                    },
                  ]
                : []),
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
                {/* One long page: links to each part, kept at the top while scrolling. */}
                <nav aria-label={t('adminNav.label')} className="sticky top-2 z-10 glass-panel rounded-full p-1.5 flex gap-1 overflow-x-auto hide-scrollbar">
                  {(
                    [
                      ['admin-analytics', t('adminNav.analytics')],
                      ['admin-users', t('adminNav.users')],
                      ['admin-machines', t('adminNav.machines')],
                      ...(currentRegion().id === 'ma' ? [['admin-master', t('adminNav.master')]] : []),
                      ['admin-data', t('adminNav.data')],
                    ] as [string, string][]
                  ).map(([id, label]) => (
                    <a
                      key={id}
                      href={`#${id}`}
                      className="shrink-0 inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.06)]"
                    >
                      {label}
                    </a>
                  ))}
                </nav>
                <div id="admin-analytics" className="scroll-mt-20">
                  <Suspense fallback={<div className="aurora-card p-10 text-center text-xs text-[var(--text-tertiary)]">{t('loadingAnalytics')}</div>}>
                    <AdminExtractionAnalytics />
                  </Suspense>
                </div>
                <div id="admin-users" className="scroll-mt-20">
                  <UserManagement />
                </div>
                <div id="admin-machines" className="w-full scroll-mt-20">
                  <MachineManager />
                </div>
                {currentRegion().id === 'ma' && (
                  <div id="admin-master" className="w-full scroll-mt-20">
                    <MasterAccountCard />
                  </div>
                )}
                <div id="admin-data" className="aurora-card aurora-card-static p-6 scroll-mt-20">
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
            {activeTab === 'PREVENTIVE_REPORTS' && features.preventive && user.role === 'ADMIN' && <PreventiveReports />}
            {activeTab === 'PREVENTIVE_CALES' && calesOn && (
              <div className="max-w-6xl mx-auto w-full pb-16">
                <CalesStock />
              </div>
            )}
            {activeTab === 'PART_REVIEW' && features.partTracking && user.role === 'ADMIN' && (
              <PartReview />
            )}
          </motion.div>
      </main>
    </div>
  );
}

/** A small menu that drops out of a tab: on hover (mouse) with a short grace period to reach it. */
function useTabMenu(enabled: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = () => {
    window.clearTimeout(timer.current);
    if (enabled) setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || (target instanceof Element && target.closest('.tab-submenu'))) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { ref, open, setOpen, show, hideSoon };
}
