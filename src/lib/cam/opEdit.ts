/*
 * An operation changed by hand (you, Beta 2: items 10 and 11): its lines moved by X, Y, Z, or taken deeper at its
 * deepest level. Word by word, on the planner's own lines (before posting): never a tool change, a machine
 * position (G53, G28, G52), a length offset (G43) or a comment; R only in a drilling cycle (its R plane).
 */

export interface OpEdit {
  dx?: number;
  dy?: number;
  dz?: number;
  /** Down this much more where the operation goes deepest (mm; negative: less deep). */
  deeper?: number;
  /** Another tool for this operation (Ø and length, mm): its path as it was, its speeds scaled (scaleSpeeds). With a
   * code: that tool of the shop (machine or tool database), whatever its kind; without one, a size typed by hand. */
  tool?: { d: number; l: number; code?: string };
  /** Deleted by hand (item 4): its lines out of the program, and its tool change with the tool's last operation there. */
  off?: true;
}

/** Spindle (S) times k and feeds (F) times kf (k < 1: slower, for a bigger Ø at the same surface speed and the same feed a turn). */
export function scaleSpeeds(lines: string[], k: number, kf = k): string[] {
  if (k === 1 && kf === 1) return lines;
  return lines.map((l) => {
    if (SKIP.test(l)) return l;
    const [code, ...rest] = l.split('(');
    const out = code.replace(/S(\d+)/g, (_, v: string) => `S${Math.max(100, Math.round((Number(v) * k) / 50) * 50)}`).replace(/F(\d*\.?\d*)/g, (_, v: string) => `F${Math.max(1, Math.round(Number(v) * kf))}.`);
    return rest.length ? [out, ...rest].join('(') : out;
  });
}

const n3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
};

const SKIP = /^\s*(T\d|M0|\()|G53|G28|G52|G43/;
const CYCLE = /G(8[1-9]|73)\b/;
const WORD = /([XYZR])(-?\d*\.?\d*)/g;

export function editOpLines(lines: string[], e: OpEdit): string[] {
  const [dx, dy, dz, deeper] = [e.dx ?? 0, e.dy ?? 0, e.dz ?? 0, e.deeper ?? 0];
  // The deepest level, before anything moves: a Z word on a line that moves the tool.
  let low = Infinity;
  for (const l of lines) {
    if (SKIP.test(l)) continue;
    for (const m of l.split('(')[0].matchAll(/Z(-?\d*\.?\d*)/g)) low = Math.min(low, Number(m[1]));
  }
  return lines.map((l) => {
    if (SKIP.test(l)) return l;
    const [code, ...rest] = l.split('(');
    const cycle = CYCLE.test(code);
    const out = code.replace(WORD, (w, k: string, v: string) => {
      if (k === 'R' && !cycle) return w;
      let x = Number(v);
      if (k === 'Z' && Math.abs(x - low) < 1e-6) x -= deeper;
      x += k === 'X' ? dx : k === 'Y' ? dy : dz;
      return `${k}${n3(x)}`;
    });
    return rest.length ? [out, ...rest].join('(') : out;
  });
}

/** Every Z word under `zMin` raised to it (the vise floor: no cut comes nearer the table the part stands on); the same array when none is. */
export function keepAbove(lines: string[], zMin: number): string[] {
  let changed = false;
  const out = lines.map((l) => {
    if (SKIP.test(l)) return l;
    const [code, ...rest] = l.split('(');
    const z = code.replace(/Z(-?\d*\.?\d*)/g, (w, v: string) => {
      if (Number(v) >= zMin - 1e-9) return w;
      changed = true;
      return `Z${n3(zMin)}`;
    });
    return rest.length ? [z, ...rest].join('(') : z;
  });
  return changed ? out : lines;
}
