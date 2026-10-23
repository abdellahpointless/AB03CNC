import { Fragment, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { Printer, QrCode, ScanLine, X } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { machineSubtitle, type FleetMachine } from '../lib/fleet';
import { checkUrl } from '../lib/phoneCheck';
import { currentRegion } from '../lib/instance';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { Flag } from './Flag';
import { useT } from '../i18n';

/** A QR code drawn as one SVG path (nothing sent to a third party). */
function QrSvg({ text, label }: { text: string; label: string }) {
  const { d, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d: path, size: n + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="qr-code" shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** The address, allowed to wrap only after "/" or "?" (never in the middle of a word). */
function BreakableUrl({ url }: { url: string }) {
  const parts: string[] = [];
  let part = '';
  for (const ch of url) {
    part += ch;
    if (ch === '/' || ch === '?') {
      parts.push(part);
      part = '';
    }
  }
  if (part) parts.push(part);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

/**
 * One QR code per machine, ready to print and stick on the machine. Scanning a code with a
 * phone opens that machine's checks (after signing in).
 */
export default function MachineQrSheet({ machines, onClose }: { machines: FleetMachine[]; onClose: () => void }) {
  const { t } = useT('preventive');
  const region = currentRegion();

  // While the sheet is open, printing prints only the sheet.
  useEffect(() => {
    document.body.classList.add('printing-qr');
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('printing-qr');
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <motion.div {...iosBackdrop} className="qr-print-root fixed inset-0 modal-backdrop z-[99990] overflow-y-auto p-3 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div {...iosSurface} role="dialog" aria-modal="true" aria-label={t('qr.title')} className="qr-sheet mx-auto max-w-5xl">
        <div className="qr-no-print flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <QrCode size={20} className="text-[var(--blue-500)]" />
            <div>
              <div className="font-bold text-[var(--text-primary)]">{t('qr.title')}</div>
              <div className="text-xs text-[var(--text-secondary)] max-w-xl">{t('qr.help')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-primary text-sm py-2 px-4" onClick={() => window.print()}>
              <Printer size={15} />
              <span>{t('qr.print')}</span>
            </button>
            <button className="btn-icon" onClick={onClose} aria-label={t('common:actions.close')}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="qr-grid">
          {machines.map((m) => {
            const url = checkUrl(m.id);
            return (
              <div key={m.id} className="qr-card">
                <div className="qr-card-kicker">
                  <Flag country={region.id} className="qr-card-flag" />
                  <span>{t('header.title')}</span>
                  <span className="qr-card-region">{region.name}</span>
                </div>
                <div className="qr-card-head">
                  <div className="min-w-0">
                    <div className="qr-card-name">
                      {m.name.split(' ').map((word, i) => (
                        <Fragment key={i}>
                          {i > 0 && ' '}
                          <span className="whitespace-nowrap">{word}</span>
                        </Fragment>
                      ))}
                    </div>
                    <div className="qr-card-sub">{machineSubtitle(m)}</div>
                  </div>
                  <img src={m.image} alt="" className="qr-card-img" />
                </div>
                <div className="qr-frame">
                  <i className="tl" />
                  <i className="tr" />
                  <i className="bl" />
                  <i className="br" />
                  <QrSvg text={url} label={`${m.name}: ${url}`} />
                </div>
                <div className="qr-card-cta">
                  <ScanLine size={16} aria-hidden="true" />
                  <span>{t('qr.scan')}</span>
                </div>
                <div className="qr-card-url">
                  <BreakableUrl url={url.replace(/^https?:\/\//, '')} />
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
