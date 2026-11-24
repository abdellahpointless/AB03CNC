import { IconArrowAutofitHeight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { fmtNumber } from '../i18n/format';

/**
 * A tool's Ø and length as two separate badges: written in one run ("Ø2, 35 mm") they read as 2.35.
 * `big`: the tool working now, in the simulator's list.
 */
export default function ToolSize({ d, l, big = false }: { d: number | null; l: number | null; big?: boolean }) {
  const { t } = useTranslation('common');
  const chip = `inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.05)] font-mono tabular-nums text-[var(--text-primary)] ${big ? 'gap-1.5 h-7 px-2.5 text-sm' : 'gap-1 h-5 px-1.5 text-[11px]'}`;
  const icon = big ? 15 : 12;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {d !== null && (
        <span className={chip} title={t('units.diameter', { mm: fmtNumber(d, 2) })} aria-label={t('units.diameter', { mm: fmtNumber(d, 2) })}>
          <span aria-hidden className={`grid place-items-center rounded-full border-[1.5px] border-current font-sans font-bold leading-none text-[#22d3ee] ${big ? 'w-4 h-4 text-[10px]' : 'w-3.5 h-3.5 text-[8px]'}`}>Ø</span>
          <b aria-hidden>{fmtNumber(d, 2)}</b>
          <span aria-hidden className="text-[var(--text-tertiary)]">mm</span>
        </span>
      )}
      {l !== null && (
        <span className={chip} title={t('units.length', { mm: fmtNumber(l, 2) })} aria-label={t('units.length', { mm: fmtNumber(l, 2) })}>
          <IconArrowAutofitHeight size={icon} stroke={1.75} aria-hidden className="text-[#facc15]" />
          <b aria-hidden>{fmtNumber(l, 2)}</b>
          <span aria-hidden className="text-[var(--text-tertiary)]">mm</span>
        </span>
      )}
    </span>
  );
}
