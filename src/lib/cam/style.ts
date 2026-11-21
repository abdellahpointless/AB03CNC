/*
 * CAM AI's program written the way the shop's programs are (docs/knowledge: gcode.onlyChangedAxes,
 * gcode.feedOnlyWhenChanged, gcode.shortNumbers and the drilling layout): the same moves in fewer
 * words. A straight move leaves out the axes that do not change and the feed when it is the same;
 * holes of one depth are one cycle, each further hole only its new X or Y; numbers drop a leading
 * zero (Z-.5). Taken only when the app's reader finds exactly the same moves in it as in the program
 * it shortens (shopStyle proves it for each program).
 */
import { parseToolpath, speedsFor, type Move } from '../toolpath';

const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
const words = (s: string) => [...s.matchAll(new RegExp(`([A-Z])(${NUM})`, 'g'))].map((m) => [m[1], m[2]] as [string, string]);
const num = (v: string) => Number(v);
const short = (v: string) => v.replace(/^(-?)0\.(?=\d)/, '$1.');

/** A drilling cycle line as CAM AI writes it: "G98 G83 X.. Y.. Z.. R.. Q.. F..". */
interface Hole { cycle: string; x: string | null; y: string | null; rest: [string, string][] }

/** The holes of one drilling block (from its cycle line to G80), or null when it is written some other way. */
function holesOf(block: string[]): Hole[] | null {
  const out: Hole[] = [];
  let cycle = '';
  let rest: [string, string][] = [];
  for (const l of block) {
    const g = l.match(/^G98 (G8[13]) /);
    if (g) cycle = g[1];
    else if (!cycle || !/^[XYZRQF]/.test(l)) return null;
    const w = words(g ? l.slice(8) : l);
    if (w.some(([k]) => !'XYZRQF'.includes(k))) return null;
    const x = w.find(([k]) => k === 'X')?.[1] ?? null;
    const y = w.find(([k]) => k === 'Y')?.[1] ?? null;
    // Z R Q F of the line, or the last ones written (a spot drilling line gives only what changes).
    const own = w.filter(([k]) => 'ZRQF'.includes(k));
    rest = g ? own : [...rest.filter(([k]) => !own.some(([o]) => o === k)), ...own].sort((a, b) => 'ZRQF'.indexOf(a[0]) - 'ZRQF'.indexOf(b[0]));
    out.push({ cycle, x, y, rest });
  }
  return out;
}

/** One cycle per depth (Z, R, Q and F alike), the further holes with only their new X or Y. */
function shopDrilling(block: string[], at: { x: string | null; y: string | null }): string[] | null {
  const holes = holesOf(block);
  if (!holes?.length) return null;
  const out: string[] = [];
  let open = '';
  let [x, y] = [at.x, at.y];
  for (const h of holes) {
    const key = `${h.cycle} ${h.rest.map(([k, v]) => `${k}${v}`).join(' ')}`;
    const move = [h.x !== null && h.x !== x ? `X${h.x}` : '', h.y !== null && h.y !== y ? `Y${h.y}` : ''].filter(Boolean).join(' ');
    if (key !== open) {
      if (open) out.push('G80');
      // To the hole at the cycle's start height, then the cycle there.
      if (move) out.push(`G00 ${move}`);
      out.push(`G98 ${key}`);
      open = key;
    } else if (move) out.push(move);
    [x, y] = [h.x ?? x, h.y ?? y];
  }
  out.push('G80');
  return out;
}

/**
 * The program, shortened line by line (no proof yet). `still`: also leave out a move to where the tool
 * already is (beyond what the engineers do: improvement O1 in docs/knowledge/cam-gaps.md, off until approved).
 */
export function shorten(code: string, still = false): string {
  const src = code.split('\n');
  const out: string[] = [];
  const pos: Record<string, string | null> = { X: null, Y: null, Z: null };
  let feed: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const n = raw.match(/^N\d+ /);
    if (!n) {
      out.push(raw);
      continue;
    }
    let l = raw.slice(n[0].length);
    const comment = l.startsWith('(') || l.startsWith('M0 (') || l.startsWith('M01');
    if (comment) {
      out.push(l);
      continue;
    }
    // Where the machine is is not known after these: nothing is left out from what follows. Their own
    // X, Y, Z are machine positions or a shift, not where the tool is (and the app's reader skips them).
    if (/(?<![A-Z])(G52|G53|G28|G30|M6)(?![0-9])/.test(l)) {
      pos.X = pos.Y = pos.Z = null;
      feed = null;
      out.push(l);
      continue;
    }
    // A drilling block: from its first cycle line to G80.
    if (/^G98 G8[13] /.test(l)) {
      const end = src.findIndex((s, k) => k > i && /^N\d+ G80$/.test(s));
      const block = end > 0 ? src.slice(i, end).map((s) => s.replace(/^N\d+ /, '')) : null;
      const shop = block && shopDrilling(block, { x: pos.X, y: pos.Y });
      if (block && shop) {
        out.push(...shop);
        const last = holesOf(block)!.reduce((a, h) => ({ x: h.x ?? a.x, y: h.y ?? a.y }), { x: pos.X, y: pos.Y });
        pos.X = last.x;
        pos.Y = last.y;
        pos.Z = null;
        feed = null;
        i = end;
        continue;
      }
    }
    if (new RegExp(`^G0?[01]( [XYZF]${NUM})+$`).test(l)) {
      const g = l.split(' ')[0];
      const kept = words(l.slice(g.length)).filter(([k, v]) => (k === 'F' ? g === 'G00' || feed === null || num(v) !== num(feed) : pos[k] === null || num(v) !== num(pos[k]!)));
      for (const [k, v] of words(l.slice(g.length))) if (k === 'F') feed = v;
      else pos[k] = v;
      // A move to where the tool is: kept as written, unless O1 is on (then no line).
      if (!kept.some(([k]) => k !== 'F')) {
        if (!still) out.push(l);
        else if (kept.length && g !== 'G00') out.push(`${g} ${kept.map(([k, v]) => `${k}${v}`).join(' ')}`);
        continue;
      }
      l = `${g} ${kept.map(([k, v]) => `${k}${v}`).join(' ')}`;
    } else {
      for (const [k, v] of words(l)) if ('XYZ'.includes(k)) pos[k] = v;
      if (/(?<![A-Z])G8\d|G80/.test(l)) {
        pos.Z = null;
        feed = null;
      }
      const f = l.match(new RegExp(`(?<![A-Z])F(${NUM})`));
      if (f) feed = f[1];
    }
    out.push(l);
  }
  let k = 0;
  return out
    .map((l) => (l === '%' || /^O\d/.test(l) || !l ? l : `N${++k} ${l.startsWith('G52') ? l : codePart(l, (c) => c.replace(new RegExp(`([XYZIJRQ])(${NUM})`, 'g'), (_w, a: string, v: string) => `${a}${short(v)}`))}`))
    .join('\n');
}

/** A move that goes nowhere (a line repeating where the tool is) is no move. */
const moving = (ms: Move[]) => ms.filter((m) => m.kind === 'drill' || m.points.some((p) => p.some((v, c) => Math.abs(v - m.points[0][c]) > 1e-9)));
/** The line with `f` applied to its code only, its comment left as written. */
function codePart(l: string, f: (code: string) => string): string {
  const at = l.indexOf('(');
  return at < 0 ? f(l) : `${f(l.slice(0, at))}${l.slice(at)}`;
}

/** The spindle, tool, offset and M words in order, and each clamping's shift: what the moves do not show. */
const machineWords = (code: string) =>
  code
    .split('\n')
    .map((l) => l.replace(/^N\d+ /, '').replace(/\([^)]*\)?/g, ''))
    .flatMap((l) => [...l.matchAll(new RegExp(`(?<![A-Z])([STHMD])(${NUM})`, 'g'))].map((m) => `${m[1]}${num(m[2])}`))
    .join(' ');

const sameMoves = (a: Move[], b: Move[]) =>
  a.length === b.length &&
  a.every((m, i) => {
    const o = b[i];
    return (
      m.kind === o.kind &&
      m.tool === o.tool &&
      m.setup === o.setup &&
      m.depth === o.depth &&
      Math.abs(m.seconds - o.seconds) < 1e-9 &&
      m.points.length === o.points.length &&
      m.points.every((p, j) => p.every((v, c) => Math.abs(v - o.points[j][c]) < 1e-9))
    );
  });

/**
 * The program in the shop's words, when the app's reader finds the very same moves in it (points,
 * depths, times, tools and setups); else the program as it was.
 */
export function shopStyle(code: string, brand?: string, shortener: (code: string) => string = shorten): { code: string; shortened: boolean } {
  const short = shortener(code);
  const speeds = speedsFor(brand);
  const [a, b] = [parseToolpath(code, speeds), parseToolpath(short, speeds)];
  const same =
    sameMoves(moving(a.moves), moving(b.moves)) &&
    machineWords(code) === machineWords(short) &&
    a.setups.length === b.setups.length &&
    a.setups.every((s, i) => JSON.stringify([s.shift, s.notes.map((x) => x.text)]) === JSON.stringify([b.setups[i].shift, b.setups[i].notes.map((x) => x.text)]));
  return same ? { code: short, shortened: true } : { code, shortened: false };
}

/** How far a run's points may lie off the arc written for them (CAM AI's offsets and its 0.001 mm rounding). */
const ON_ARC = 0.003;
/** How far the old straight pieces may stray from the arc (CAM AI's own offset tolerance, 0.002 to 0.01 mm). */
const CHORD = 0.012;
type P = [number, number];

/** The circle best through points i..j (least squares, Kasa), or null when they are nearly straight. */
function bestCircle(pts: P[], i: number, j: number): P | null {
  // Solve for D, E, F in x² + y² + Dx + Ey + F = 0 (about the first point, for precision).
  const [ox, oy] = pts[i];
  let [sxx, sxy, syy, sx, sy, n, sxz, syz, sz] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = i; k <= j; k++) {
    const [x, y] = [pts[k][0] - ox, pts[k][1] - oy];
    const z = x * x + y * y;
    [sxx, sxy, syy, sx, sy, n] = [sxx + x * x, sxy + x * y, syy + y * y, sx + x, sy + y, n + 1];
    [sxz, syz, sz] = [sxz + x * z, syz + y * z, sz + z];
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const v = [-sxz, -syz, -sz];
  const det = (A: number[][]) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const d0 = det(M);
  if (Math.abs(d0) < 1e-12) return null;
  const col = (c: number) => M.map((row, r) => row.map((x, k) => (k === c ? v[r] : x)));
  const [D, E] = [det(col(0)) / d0, det(col(1)) / d0];
  return [ox - D / 2, oy - E / 2];
}

/** The arc through points i..j (centre, radius, clockwise), when they all lie on it in order; else null. */
function arcThrough(pts: P[], i: number, j: number): { c: P; r: number; cw: boolean } | null {
  const [a, m, b] = [pts[i], pts[Math.round((i + j) / 2)], pts[j]];
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: P) => p[0] * p[0] + p[1] * p[1];
  const three: P = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
  // The least-squares centre (cleaner I and J), else the one through the three points.
  return onArc(pts, i, j, bestCircle(pts, i, j)) ?? onArc(pts, i, j, three);
}

function onArc(pts: P[], i: number, j: number, c: P | null): { c: P; r: number; cw: boolean } | null {
  if (!c || !c.every(Number.isFinite)) return null;
  const [a, m, b] = [pts[i], pts[Math.round((i + j) / 2)], pts[j]];
  const r = (Math.hypot(a[0] - c[0], a[1] - c[1]) + Math.hypot(b[0] - c[0], b[1] - c[1])) / 2;
  if (r < 0.2 || r > 2000) return null;
  const cross = (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]);
  const cw = cross < 0;
  let swept = 0;
  let prev = Math.atan2(a[1] - c[1], a[0] - c[0]);
  for (let k = i + 1; k <= j; k++) {
    const p = pts[k];
    if (Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - r) > ON_ARC) return null;
    const L = Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]);
    if (L < 1e-6 || L > 2 * r || r - Math.sqrt(r * r - (L / 2) ** 2) > CHORD) return null;
    // Each point a little further round the same way (less than half a turn per piece).
    const ang = Math.atan2(p[1] - c[1], p[0] - c[0]);
    let step = ang - prev;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    if ((cw ? -step : step) <= 0) return null;
    swept += Math.abs(step);
    prev = ang;
  }
  return swept < (350 * Math.PI) / 180 ? { c, r, cw } : null;
}

const n3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return short(Number.isInteger(r) ? `${r}.` : String(r));
};

/**
 * Straight feed moves on one level that lie on a circle, as one arc: G02/G03 to the run's last point,
 * I and J from its first (the shop writes arcs this way, docs/knowledge: gcode.arcsIJ). At least three
 * pieces per arc, within ON_ARC of every point and CHORD of every piece. The program it gives must be
 * checked again (camProgram does: the simulation, against the model).
 */
export function arcs(code: string): string {
  const src = code.split('\n');
  const out: string[] = [];
  const pos: Record<string, number | null> = { X: null, Y: null, Z: null };
  const straight = new RegExp(`^N\\d+ G0?1((?: [XY]${NUM}){1,2})( F${NUM})?$`);
  let i = 0;
  while (i < src.length) {
    const l = src[i];
    const m = l.match(straight);
    if (!m || pos.X === null || pos.Y === null) {
      for (const [k, v] of words(l.replace(/^N\d+ /, '').replace(/\([^)]*\)/g, ''))) if (k in pos) pos[k] = num(v);
      if (/(?<![A-Z])(G52|G53|G28|G30|M6)(?![0-9])/.test(l)) pos.X = pos.Y = pos.Z = null;
      out.push(l);
      i++;
      continue;
    }
    // The run: straight feed moves in X/Y only, a feed on its first line at most.
    const pts: P[] = [[pos.X, pos.Y]];
    const at: number[] = [];
    let j = i;
    let [x, y] = [pos.X, pos.Y];
    while (j < src.length) {
      const q = src[j].match(straight);
      if (!q || (j > i && q[2])) break;
      for (const [k, v] of words(q[1])) k === 'X' ? (x = num(v)) : (y = num(v));
      pts.push([x, y]);
      at.push(j);
      j++;
    }
    const feed = m[2] ?? '';
    let k = 0;
    while (k < at.length) {
      let best: { e: number; arc: { c: P; r: number; cw: boolean } } | null = null;
      for (let e = k + 3; e < pts.length && e - k <= 2000; e++) {
        const arc = arcThrough(pts, k, e);
        if (!arc) break;
        best = { e, arc };
      }
      if (best) {
        const [s, t] = [pts[k], pts[best.e]];
        const [I, J] = [best.arc.c[0] - s[0], best.arc.c[1] - s[1]];
        // The control checks the end is as far from the centre as the start.
        const c: P = [s[0] + Math.round(I * 1000) / 1000, s[1] + Math.round(J * 1000) / 1000];
        if (Math.abs(Math.hypot(t[0] - c[0], t[1] - c[1]) - Math.hypot(s[0] - c[0], s[1] - c[1])) <= 0.002) {
          out.push(`N0 ${best.arc.cw ? 'G02' : 'G03'} X${n3(t[0])} Y${n3(t[1])} I${n3(I)} J${n3(J)}${k === 0 ? feed : ''}`);
          k = best.e;
          continue;
        }
      }
      // Not an arc: the line as written (it follows the same point as before).
      out.push(k === 0 ? src[at[k]] : src[at[k]].replace(new RegExp(` F${NUM}$`), ''));
      k++;
    }
    [pos.X, pos.Y] = [x, y];
    i = j;
  }
  let n = 0;
  return out.map((l) => (/^N\d+ /.test(l) ? `N${++n} ${l.replace(/^N\d+ /, '')}` : l)).join('\n');
}
