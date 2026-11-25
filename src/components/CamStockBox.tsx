import { useTranslation } from 'react-i18next';
import { fmtNumber as fmt } from '../i18n/format';

/** The six sides of clamping 1, in the order of `values`: X-, X+, Y-, Y+, Z- (under the part), Z+ (over it). */
export const STOCK_SIDES = ['X-', 'X+', 'Y-', 'Y+', 'Z-', 'Z+'] as const;

// Seen from the front, right, top (X+, Y-, Z+ toward the eye): X and Y to the right, Z up.
const P = (x: number, y: number, z: number): [number, number] => [(x + y) * 0.7071, (x - y - 2 * z) * 0.4082];

/** A box's three faces seen from the front, right and top (Z+, Y-, X+), or the three behind them (Z-, Y+, X-), as SVG points. */
function faces(lo: number[], hi: number[], back = false) {
  const pts = (q: number[][]) => q.map(([x, y, z]) => P(x, y, z).join(',')).join(' ');
  const [z, y, x] = back ? [lo[2], hi[1], lo[0]] : [hi[2], lo[1], hi[0]];
  return [
    pts([[lo[0], lo[1], z], [hi[0], lo[1], z], [hi[0], hi[1], z], [lo[0], hi[1], z]]),
    pts([[lo[0], y, lo[2]], [hi[0], y, lo[2]], [hi[0], y, hi[2]], [lo[0], y, hi[2]]]),
    pts([[x, lo[1], lo[2]], [x, hi[1], lo[2]], [x, hi[1], hi[2]], [x, lo[1], hi[2]]]),
  ];
}

/**
 * The blank round the part, side by side (you, Beta 2): the part (grey) in its blank (amber), as clamping 1 holds it,
 * with the stock on each of its six sides typed where that side is.
 */
export default function CamStockBox({ size, values, onChange, locked = -1 }: { size: number[]; values: string[]; onChange?: (i: number, v: string) => void; locked?: number }) {
  const { t } = useTranslation('cam');
  const m = values.map((v) => Math.max(0, Number(v) || 0));
  const lo = [-m[0], -m[2], -m[4]];
  const hi = [size[0] + m[1], size[1] + m[3], size[2] + m[5]];
  // Fit the drawing: the blank's corners on screen.
  const corners = [0, 1].flatMap((a) => [0, 1].flatMap((b) => [0, 1].map((c) => P(a ? hi[0] : lo[0], b ? hi[1] : lo[1], c ? hi[2] : lo[2]))));
  const [x0, x1] = [Math.min(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[1]))];
  const span = Math.max(x1 - x0, y1 - y0);
  const pad = span * 0.06;
  const input = (i: number) => (
    <label key={STOCK_SIDES[i]} className="flex flex-col items-center gap-0.5">
      <span className="font-mono text-[11px] font-bold text-[#f5a524]">{STOCK_SIDES[i]}</span>
      <input
        className="aurora-input w-14 text-xs px-1.5 text-center tabular-nums"
        type="number"
        min={0}
        step={0.5}
        inputMode="decimal"
        value={values[i]}
        disabled={i === locked || !onChange}
        onChange={(e) => onChange?.(i, e.target.value)}
        aria-label={t('camAi.stock.sideLabel', { side: STOCK_SIDES[i] })}
      />
    </label>
  );
  return (
    <div className="grid grid-cols-[auto_1fr_auto] grid-rows-[auto_1fr_auto] items-center justify-items-center gap-1.5">
      <span />
      <div className="flex gap-3">
        {input(5)}
        {input(3)}
      </div>
      <span />
      {input(0)}
      <svg viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} className="w-full max-w-[14rem] h-44" role="img" aria-label={t('camAi.stock.boxLabel', { x: fmt(hi[0] - lo[0], 1), y: fmt(hi[1] - lo[1], 1), z: fmt(hi[2] - lo[2], 1) })}>
        {/* The blank's far faces (dashed), the part, then the blank's near faces over it. */}
        {faces(lo, hi, true).map((pts, i) => (
          <polygon key={`b${i}`} points={pts} fill="#f5a524" fillOpacity={0.06} stroke="#f5a524" strokeOpacity={0.6} strokeDasharray={`${span / 50} ${span / 70}`} strokeWidth={span / 220} />
        ))}
        {faces([0, 0, 0], size).map((pts, i) => (
          <polygon key={`p${i}`} points={pts} fill={['#c8d0db', '#9aa6b6', '#7d8898'][i]} stroke="#5b6678" strokeWidth={span / 260} />
        ))}
        {faces(lo, hi).map((pts, i) => (
          <polygon key={`s${i}`} points={pts} fill="#f5a524" fillOpacity={0.14} stroke="#f5a524" strokeLinejoin="round" strokeWidth={span / 140} />
        ))}
      </svg>
      {input(1)}
      <span />
      <div className="flex gap-3">
        {input(2)}
        {input(4)}
      </div>
      <span />
      <p className="col-span-3 text-[11px] text-[var(--text-tertiary)] tabular-nums">{t('camAi.stock.partIn', { x: fmt(size[0], 1), y: fmt(size[1], 1), z: fmt(size[2], 1) })}</p>
    </div>
  );
}
