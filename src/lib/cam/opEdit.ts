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
