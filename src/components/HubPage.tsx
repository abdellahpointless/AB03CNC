import React from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Crown, Lock } from 'lucide-react';
import i18n from '../i18n';
import { REGIONS, UPCOMING_COUNTRIES, type RegionInfo } from '../regions';
import { MASTER_PATH, countryPath, lastCountry, rememberCountry } from '../lib/instance';
import { Flag } from './Flag';
import { SPRING_POP } from '../lib/motion';

/**
 * The page at the root of the site: people pick the country they work in, and the app opens
 * that country's own instance (/ma/, /tr/). Written in every country's language at once, since
 * we do not know yet who is looking.
 */
export default function HubPage() {
  const last = lastCountry();
  const both = (key: 'hub:title' | 'hub:master' | 'hub:comingSoon' | 'hub:notAvailable') => {
    const texts = Array.from(new Set(['en', 'tr'].map((lng) => i18n.t(key, { lng }) as string)));
    return texts.join(' · ');
  };

  const open = (r: RegionInfo) => {
    rememberCountry(r.id);
    window.location.assign(countryPath(r.id));
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8 relative overflow-hidden">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[620px] h-[320px] bg-[var(--blue-500)] opacity-10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[420px] h-[300px] bg-[#E30A17] opacity-[0.05] blur-[110px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', duration: 0.6, bounce: 0.15 }}
        className="relative z-10 flex flex-col items-center text-center mb-10"
      >
        <div className="relative mb-4">
          <div className="w-14 h-14 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--blue-500)] to-indigo-700 flex items-center justify-center text-white font-mono font-extrabold text-xl shadow-[0_8px_20px_rgba(59,111,212,0.4)]">
            //
          </div>
          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--green-500)] border-2 border-[var(--bg-panel)] shadow-[0_0_8px_var(--green-glow)]" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">CNC Process Pro</h1>
        <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">{both('hub:title')}</p>
        <p className="mt-1 text-xs text-[var(--text-secondary)] max-w-md">{i18n.t('hub:subtitle', { lng: 'en' })}</p>
        <p className="text-xs text-[var(--text-secondary)] max-w-md">{i18n.t('hub:subtitle', { lng: 'tr' })}</p>
      </motion.div>

      <div className="relative z-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 w-full max-w-2xl lg:max-w-4xl">
        {REGIONS.map((r, i) => (
          <motion.button
            key={r.id}
            type="button"
            onClick={() => open(r)}
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...SPRING_POP, delay: 0.08 + i * 0.07 }}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.98 }}
            className={`no-glass group text-left glass-panel p-6 flex flex-col gap-5 cursor-pointer border transition-colors ${
              last === r.id ? 'border-[var(--blue-500)]/60' : 'border-transparent hover:border-[var(--border-strong)]'
            }`}
            aria-label={`${r.name} (${i18n.t(`common:language.${r.language}`)})`}
          >
            <div className="flex items-start justify-between gap-3">
              <Flag country={r.id} className="w-20 h-[54px] rounded-[6px] shadow-[0_6px_18px_rgba(0,0,0,0.35)]" />
              {last === r.id && (
                <span className="badge-neutral text-xs py-0.5 px-2">{i18n.t('hub:lastUsed', { lng: r.language })}</span>
              )}
            </div>
            <div>
              <div className="text-xl font-bold text-[var(--text-primary)]">{i18n.t(`common:country.${r.id}`, { lng: r.language })}</div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                {i18n.t('hub:language', { lng: r.language, language: i18n.t(`common:language.${r.language}`) })}
              </div>
            </div>
            <div className="flex items-center justify-between text-sm font-semibold text-[var(--blue-text)]">
              <span>{i18n.t('hub:open', { lng: r.language })}</span>
              <ArrowRight size={18} className="transition-transform group-hover:translate-x-1" />
            </div>
          </motion.button>
        ))}
        {/* Countries announced but not open yet: visible, locked, not clickable. */}
        {UPCOMING_COUNTRIES.map((c, i) => (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...SPRING_POP, delay: 0.08 + (REGIONS.length + i) * 0.07 }}
            className="no-glass glass-panel p-6 flex flex-col gap-5 border border-dashed border-[var(--border-subtle)] cursor-not-allowed select-none"
            aria-disabled="true"
            aria-label={`${c.name}: ${i18n.t('hub:notAvailable', { lng: 'en' })}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="relative">
                <Flag country={c.id} className="w-20 h-[54px] rounded-[6px] opacity-45 grayscale-[35%]" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="w-8 h-8 rounded-full bg-[var(--bg-panel)]/90 border border-[var(--border-subtle)] flex items-center justify-center shadow-md">
                    <Lock size={15} className="text-[var(--text-secondary)]" />
                  </span>
                </span>
              </div>
              <span className="badge-neutral text-xs py-0.5 px-2 whitespace-nowrap shrink-0">{both('hub:comingSoon')}</span>
            </div>
            <div className="opacity-70">
              <div className="text-xl font-bold text-[var(--text-primary)]">
                {c.name} <span className="text-sm font-semibold text-[var(--text-secondary)]">· {c.nativeName}</span>
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">{c.languageName}</div>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-tertiary)]">
              <Lock size={13} className="shrink-0" />
              <span>{both('hub:notAvailable')}</span>
            </div>
          </motion.div>
        ))}
      </div>

      <motion.a
        href={MASTER_PATH}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.3 }}
        className="relative z-10 mt-10 inline-flex items-center gap-2 py-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <Crown size={13} className="text-amber-500" />
        <span>{both('hub:master')}</span>
        <span className="hidden sm:inline">- {i18n.t('hub:masterHint', { lng: 'en' })}</span>
      </motion.a>
    </main>
  );
}
