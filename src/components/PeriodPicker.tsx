import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftPeriod, type PartsPeriod } from '../lib/partsApi';
import { useT } from '../i18n';

/** From - To days (the end day not counted), with arrows that move the period by a month. */
export default function PeriodPicker({ value, onChange }: { value: PartsPeriod; onChange: (p: PartsPeriod) => void }) {
  const { t } = useT('parts');
  return (
    <div role="group" aria-label={t('review.period')} className="flex flex-wrap items-center gap-1.5 text-xs">
      <button type="button" className="btn-icon" onClick={() => onChange(shiftPeriod(value, -1))} aria-label={t('review.previousPeriod')} title={t('review.previousPeriod')}>
        <ChevronLeft size={15} />
      </button>
      <label className="flex items-center gap-1.5">
        <span className="text-[var(--text-secondary)]">{t('review.from')}</span>
        <input type="date" className="aurora-input text-xs py-1.5 px-2" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="flex items-center gap-1.5">
        <span className="text-[var(--text-secondary)]">{t('review.to')}</span>
        <input type="date" className="aurora-input text-xs py-1.5 px-2" value={value.to} min={value.from} title={t('review.toHint')} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
      <button type="button" className="btn-icon" onClick={() => onChange(shiftPeriod(value, 1))} aria-label={t('review.nextPeriod')} title={t('review.nextPeriod')}>
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
