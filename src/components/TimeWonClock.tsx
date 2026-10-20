import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatTimeWon, DEFAULT_SAVED_SECONDS_PER_EXTRACTION } from '../lib/extractionAnalytics';
import { useSync } from '../contexts/SyncContext';
import { Clock, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Trans } from 'react-i18next';
import { useT } from '../i18n';

interface TimeWonClockProps {
  onClick?: () => void;
  compact?: boolean;
}

export const TimeWonClock: React.FC<TimeWonClockProps> = ({ onClick, compact = false }) => {
  const { t } = useT('history');
  const { analytics: liveAnalytics } = useSync();
  const analytics = liveAnalytics ?? {
    totalExtractions: 0,
    totalTimeSavedSeconds: 0,
    savedSecondsPerExtraction: DEFAULT_SAVED_SECONDS_PER_EXTRACTION,
    contributingUsers: 0,
  };
  const timeWon = formatTimeWon(analytics.totalTimeSavedSeconds);
  const perCode = formatTimeWon(analytics.savedSecondsPerExtraction).formatted;
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipCoords, setTooltipCoords] = useState<{ top: number; right: number } | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const updateCoords = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setTooltipCoords({
        top: rect.bottom + 8,
        right: Math.max(16, window.innerWidth - rect.right),
      });
    }
  };

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    updateCoords();
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    leaveTimerRef.current = setTimeout(() => {
      setShowTooltip(false);
    }, 180);
  };

  // SVG Clock with live second-ticking animation
  const secondsAngle = (timeWon.seconds * 6) % 360;
  const minutesAngle = (timeWon.minutes * 6 + timeWon.seconds * 0.1) % 360;
  const hoursAngle = ((timeWon.hours % 12) * 30 + timeWon.minutes * 0.5) % 360;

  if (compact) {
    return (
      <div 
        className="inline-flex items-center shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          ref={buttonRef}
          onClick={onClick}
          title={t('clock.openTitle')}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--green-500)]/30 bg-[rgba(22,163,74,0.12)] hover:bg-[rgba(22,163,74,0.18)] transition-colors cursor-pointer shadow-xs shrink-0 select-none"
        >
          {/* Mini Analog Clock Icon */}
          <div className="relative w-4 h-4 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-[var(--green-500)]">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <line
                x1="12"
                y1="12"
                x2="12"
                y2="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                transform={`rotate(${hoursAngle} 12 12)`}
              />
              <line
                x1="12"
                y1="12"
                x2="12"
                y2="4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                transform={`rotate(${minutesAngle} 12 12)`}
              />
            </svg>
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-[var(--green-500)] rounded-full shadow-[0_0_4px_var(--green-glow)]" />
          </div>

          <div className="flex items-baseline gap-1 text-xs whitespace-nowrap">
            <span className="text-[var(--text-tertiary)] font-medium hidden sm:inline uppercase text-[10px] tracking-wider">{t('clock.won')}</span>
            <span className="font-mono font-bold text-[var(--green-500)] tabular-nums">
              {timeWon.formatted}
            </span>
          </div>

          <span className="badge-neutral text-[10px] py-0 px-1.5 text-[var(--text-secondary)] whitespace-nowrap">
            {t('clock.codes', { count: analytics.totalExtractions })}
          </span>
        </button>

        {/* Floating Tooltip in Portal so it CANNOT shift or expand the header */}
        {typeof document !== 'undefined' && createPortal(
          <AnimatePresence>
            {showTooltip && tooltipCoords && (
              <motion.div 
                key="mac-ghost-tooltip"
                style={{
                  position: 'fixed',
                  top: tooltipCoords.top,
                  right: tooltipCoords.right,
                  zIndex: 999999,
                }}
                initial={{ 
                  opacity: 0, 
                  scaleX: 0.35, 
                  scaleY: 0.15, 
                  y: -14, 
                  filter: 'blur(8px)',
                  transformOrigin: '90% 0%'
                }}
                animate={{ 
                  opacity: 1, 
                  scaleX: [0.35, 1.08, 0.97, 1.02, 1], 
                  scaleY: [0.15, 1.16, 0.95, 1.02, 1], 
                  y: [ -14, 2, -1, 0 ], 
                  filter: 'blur(0px)',
                  transformOrigin: '90% 0%'
                }}
                exit={{ 
                  opacity: 0, 
                  scaleX: 0.45, 
                  scaleY: 0.2, 
                  y: -10, 
                  filter: 'blur(6px)',
                  transformOrigin: '90% 0%',
                  transition: { duration: 0.18, ease: [0.32, 0, 0.67, 0] }
                }}
                transition={{ 
                  duration: 0.36, 
                  ease: [0.16, 1, 0.3, 1],
                  times: [0, 0.45, 0.7, 0.88, 1]
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className="w-72 sm:w-80 p-4 glass-modal shadow-2xl pointer-events-auto rounded-[var(--radius-lg)] border border-[rgba(var(--ov),0.18)] will-change-transform transform-gpu"
              >
                <div className="flex items-center gap-2 font-bold text-[var(--text-primary)] mb-1 text-xs">
                  <Clock size={14} className="text-[var(--green-500)]" />
                  <span>{t('clock.calculatorTitle')}</span>
                </div>
                <p className="text-[var(--text-secondary)] mb-3 text-xs leading-relaxed">
                  <Trans t={t} i18nKey="clock.calculatorText" components={{ b: <strong className="text-[var(--text-primary)]" /> }} />
                </p>
                <div className="p-2.5 bg-[var(--bg-input)] rounded-[var(--radius-md)] space-y-1.5 font-mono text-[11px] border border-[var(--border-subtle)]">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-tertiary)]">{t('clock.totalExtractions')}</span>
                    <span className="font-bold text-[var(--text-primary)] tabular-nums">{analytics.totalExtractions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-tertiary)]">{t('clock.avgSaved')}</span>
                    <span className="font-bold text-[var(--green-500)] tabular-nums">~{perCode}</span>
                  </div>
                  <div className="flex justify-between border-t border-[var(--border-subtle)] pt-1">
                    <span className="text-[var(--text-tertiary)]">{t('clock.totalSaved')}</span>
                    <span className="font-bold text-[var(--green-500)] tabular-nums">{timeWon.formatted}</span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
      </div>
    );
  }

  // Standalone Widget (Aurora Card)
  return (
    <div className="aurora-card p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          {/* Animated Analog Clock Face */}
          <div className="relative w-16 h-16 rounded-full bg-[var(--bg-input)] border-2 border-[var(--green-500)]/60 shadow-[0_0_15px_var(--green-glow)] flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" className="w-12 h-12 text-[var(--text-primary)]">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity="0.2" />
              <line x1="12" y1="3" x2="12" y2="4.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="21" y1="12" x2="19.5" y2="12" stroke="currentColor" strokeWidth="1.5" />
              <line x1="12" y1="21" x2="12" y2="19.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="3" y1="12" x2="4.5" y2="12" stroke="currentColor" strokeWidth="1.5" />
              {/* Hour hand */}
              <line
                x1="12"
                y1="12"
                x2="12"
                y2="6.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                transform={`rotate(${hoursAngle} 12 12)`}
              />
              {/* Minute hand */}
              <line
                x1="12"
                y1="12"
                x2="12"
                y2="4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                transform={`rotate(${minutesAngle} 12 12)`}
              />
              {/* Second hand */}
              <line
                x1="12"
                y1="12"
                x2="12"
                y2="4"
                stroke="var(--green-500)"
                strokeWidth="1"
                strokeLinecap="round"
                transform={`rotate(${secondsAngle} 12 12)`}
              />
              <circle cx="12" cy="12" r="1.5" fill="var(--green-500)" />
            </svg>
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-[var(--green-500)] rounded-full border-2 border-[var(--bg-card)] shadow-[0_0_6px_var(--green-glow)]" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="section-label flex items-center gap-1.5 text-[var(--green-500)]">
                <Sparkles size={13} className="text-[var(--green-500)]" />
                {t('clock.widgetTitle')}
              </span>
              <span className="badge-positive text-[10px] py-0 px-2">
                {t('clock.faster')}
              </span>
            </div>
            
            <div className="stat-metric-number text-[var(--green-500)] mt-1">
              {timeWon.formatted}
            </div>

            <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
              <Trans t={t} i18nKey="clock.widgetText" values={{ perCode }} components={{ b: <strong className="text-[var(--text-primary)]" /> }} />
            </p>
          </div>
        </div>

        {/* Quick Stats Column */}
        <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-3 border-t sm:border-t-0 sm:border-l border-[var(--border-subtle)] pt-4 sm:pt-0 sm:pl-6">
          <div className="text-left sm:text-right">
            <span className="section-label block">{t('clock.codesExtracted')}</span>
            <span className="text-2xl font-black text-[var(--text-primary)] tabular-nums">
              {analytics.totalExtractions}
            </span>
          </div>

          <div className="text-right">
            <span className="section-label block">{t('clock.contributingUsers')}</span>
            <span className="text-sm font-bold text-[var(--text-secondary)]">
              {t('clock.users', { count: analytics.contributingUsers })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
