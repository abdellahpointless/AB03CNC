/**
 * A small simulator for checking how CAM AI writes holes (the owner's hole rules, 2026-11-27): it reads G00-G03 (arcs
 * with I/J, helical with Z), G73, G81, G83 with G98/G99 and G80, expands the canned cycles as a Haas does (Setting 22's
 * delta: G73's retract and G83's stop above the last peck), finds the holes, and times every move with trapezoidal
 * acceleration. Program frame (G52 shifts left out: the old and new programs share them).
 */

export type V3 = [number, number, number];
export interface SimOpts {
  /** Haas Setting 22 (mm): G73 retract after each peck, G83 rapid back down to this far above the last peck. */
  delta: number;
  /** Rapid rate (mm/min); the VF-4 does 1000 in/min. */
  rapid: number;
  /** Axis acceleration (mm/s²), and the time each block takes besides its move (s). */
  accel: number;
  block: number;
}
export const SIM_DEFAULTS: SimOpts = { delta: 1.27, rapid: 25400, accel: 2500, block: 0.002 };

export interface SimMove {
  kind: 'rapid' | 'feed';
  from: V3;
  to: V3;
  /** mm/min for feeds. */
  f: number;
  /** Path length (arcs: along the helix). */
  len: number;
  /** Time (s) when it is a share of a longer move (an arc's chord: the arc is one move to the machine). */
  t?: number;
  line: number;
  op: number;
}
export interface SimHole {
  op: number;
  /** Tool Ø of the operation (from its DIAMETER comment). */
  d: number;
  c: [number, number];
  bottom: number;
  /** Where the tool starts feeding down (a cycle's R; a milled hole's first feed down). */
  start: number;
  /** Diameter swept: the tool's plus twice the widest the centre goes from the hole's centre. */
  swept: number;
  how: 'G81' | 'G73' | 'G83' | 'milled';
  line: number;
}
export interface SimResult {
  moves: SimMove[];
  holes: SimHole[];
  seconds: number;
  /** Lines with code (not blank, not only a comment). */
  lines: number;
}

/** Time of one move: accelerate to v, cruise, stop (a triangle when too short to reach v), plus the block time. */
export function moveTime(len: number, mmPerMin: number, o: SimOpts = SIM_DEFAULTS): number {
  if (len <= 0) return o.block;
  const v = mmPerMin / 60;
  const reach = (v * v) / o.accel;
  return (len < reach ? 2 * Math.sqrt(len / o.accel) : len / v + v / o.accel) + o.block;
}

export function simulate(code: string, opts: Partial<SimOpts> = {}): SimResult {
  const o = { ...SIM_DEFAULTS, ...opts };
  const moves: SimMove[] = [];
  const holes: SimHole[] = [];
  let pos: V3 = [0, 0, 50];
  let motion = 0;
  let feed = 0;
  let back: 'G98' | 'G99' = 'G98';
  let cycle: null | { g: 'G81' | 'G73' | 'G83'; z: number; r: number; q: number; initial: number } = null;
  let op = -1;
  let d = 0;
  let lines = 0;
  const go = (kind: SimMove['kind'], to: V3, line: number, len = Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2]), t?: number) => {
    moves.push({ kind, from: pos, to, f: feed, len, line, op, ...(t === undefined ? {} : { t }) });
    pos = to;
  };
  const src = code.split('\n');
  src.forEach((raw, i) => {
    const l = raw.replace(/\([^)]*\)/g, '').replace(/^\s*N\d+\s*/, '').trim().toUpperCase();
    if (!l || l === '%' || /^O\d/.test(l)) return;
    lines++;
    const word = (k: string) => {
      const m = l.match(new RegExp(`(?<![A-Z])${k}(-?\\d*\\.?\\d+)`));
      return m ? Number(m[1]) : undefined;
    };
    const gs = [...l.matchAll(/(?<![A-Z])G(\d+)/g)].map((m) => Number(m[1]));
    if (/(?<![A-Z])M0?6(?!\d)/.test(l)) {
      op++;
      const dia = src.slice(i + 1, i + 5).join(' ').match(/DIAMETER ([\d.]+) MM/);
      d = dia ? Number(dia[1]) : 0;
    }
    if (gs.some((g) => g === 52 || g === 53)) return;
    const f = word('F');
    if (f !== undefined) feed = f;
    for (const g of gs) {
      if (g === 98) back = 'G98';
      if (g === 99) back = 'G99';
      if (g === 80) cycle = null;
      if (g <= 3) motion = g;
    }
    const [x, y, z] = [word('X') ?? pos[0], word('Y') ?? pos[1], word('Z')];
    const startCycle = gs.find((g) => g === 81 || g === 73 || g === 83);
    if (startCycle) cycle = { g: `G${startCycle}` as 'G81' | 'G73' | 'G83', z: z ?? pos[2], r: word('R') ?? pos[2], q: word('Q') ?? 0, initial: pos[2] };
    if (cycle && (startCycle || word('X') !== undefined || word('Y') !== undefined)) {
      // A hole of the cycle: Z, R, Q kept from the cycle line unless this line gives new ones.
      if (!startCycle) {
        if (z !== undefined) cycle.z = z;
        const r = word('R');
        if (r !== undefined) cycle.r = r;
        const q = word('Q');
        if (q !== undefined) cycle.q = q;
      }
      const c = cycle;
      go('rapid', [x, y, pos[2]], i);
      go('rapid', [x, y, c.r], i);
      let depth = c.r;
      if (c.g === 'G81' || c.q <= 0) go('feed', [x, y, c.z], i);
      else
        while (depth > c.z + 1e-9) {
          const next = Math.max(depth - c.q, c.z);
          if (depth !== c.r) {
            if (c.g === 'G83') go('rapid', [x, y, c.r], i), go('rapid', [x, y, depth + o.delta], i);
            else go('rapid', [x, y, depth + o.delta], i);
          }
          go('feed', [x, y, next], i);
          depth = next;
        }
      go('rapid', [x, y, back === 'G98' ? c.initial : c.r], i);
      holes.push({ op, d, c: [x, y], bottom: c.z, start: c.r, swept: d, how: c.g, line: i });
      return;
    }
    if (word('X') === undefined && word('Y') === undefined && z === undefined) return;
    const to: V3 = [x, y, z ?? pos[2]];
    if (motion === 2 || motion === 3) {
      const [cx, cy] = [pos[0] + (word('I') ?? 0), pos[1] + (word('J') ?? 0)];
      const r = Math.hypot(pos[0] - cx, pos[1] - cy);
      const a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
      let a1 = Math.atan2(to[1] - cy, to[0] - cx);
      if (motion === 2) while (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI;
      else while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
      const sweep = Math.abs(a1 - a0);
      // The arc as short chords (for where it goes), timed as the one move along the helix it is to the machine.
      const n = Math.max(4, Math.ceil(sweep / (Math.PI / 18)));
      const z0 = pos[2];
      const len = Math.hypot(r * sweep, to[2] - z0);
      const t = moveTime(len, feed || 1, o) / n;
      for (let k = 1; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        go('feed', [cx + r * Math.cos(a), cy + r * Math.sin(a), z0 + ((to[2] - z0) * k) / n], i, len / n, t);
      }
      return;
    }
    go(motion === 0 ? 'rapid' : 'feed', to, i);
  });
  // Holes milled: within one operation, a run of feeds that goes down overall while staying within the tool's Ø of
  // where it started (a plunge, a helix, circles a level: a ring smaller than the tool spans up to its Ø).
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    if (m.kind !== 'feed' || m.to[2] >= m.from[2] - 1e-9) continue;
    const opD = holes.find((h) => h.op === m.op)?.d ?? diaOf(code, m.op);
    let j = k;
    const pts: V3[] = [m.from, m.to];
    while (j + 1 < moves.length && moves[j + 1].kind === 'feed' && moves[j + 1].op === m.op && Math.hypot(moves[j + 1].to[0] - m.from[0], moves[j + 1].to[1] - m.from[1]) <= Math.max(opD, 0.5)) pts.push(moves[++j].to);
    const zs = pts.map((p) => p[2]);
    if (Math.min(...zs) > m.from[2] - 0.5 || j === k) continue;
    // Its centre: the middle of the box its points span (a full turn round, or one point for a plunge).
    const [xs, ys] = [pts.map((p) => p[0]), pts.map((p) => p[1])];
    const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const widest = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
    holes.push({ op: m.op, d: opD, c: [cx, cy], bottom: Math.min(...zs), start: m.from[2], swept: opD + 2 * widest, how: 'milled', line: m.line });
    k = j;
  }
  const seconds = moves.reduce((t, m) => t + (m.t ?? moveTime(m.len, m.kind === 'rapid' ? o.rapid : m.f || 1, o)), 0);
  return { moves, holes, seconds, lines };
}

/** The tool Ø of operation `op` (its DIAMETER comment after the op-th tool change). */
function diaOf(code: string, op: number): number {
  const all = [...code.matchAll(/M0?6[^\n]*\n[^\n]*\n[^\n]*DIAMETER ([\d.]+) MM/g)];
  return all[op] ? Number(all[op][1]) : 0;
}

/**
 * Every hole of `before` in `after` (the owner's checks): its centre within 0.005 mm, the same bottom, the swept Ø as
 * the cycle rule allows (the same, or the tool's when the loop was within the tolerance), a start never lower than
 * where the material over it starts (`top`, or the old start less its old margin), never more lines. The problems.
 */
export function compareHoles(before: SimResult, after: SimResult, o: { tol?: number; oldMargin?: number; margin?: number } = {}): string[] {
  const tol = o.tol ?? 0.02;
  const out: string[] = [];
  const used = new Set<SimHole>();
  for (const h of before.holes) {
    const n = after.holes.find((x) => !used.has(x) && Math.abs(x.d - h.d) < 1e-6 && Math.hypot(x.c[0] - h.c[0], x.c[1] - h.c[1]) <= 0.005 + (h.how === 'milled' ? 0.01 : 0));
    const at = `T Ø${h.d} at ${h.c.map((v) => v.toFixed(3)).join(',')}`;
    if (!n) {
      out.push(`${at}: missing`);
      continue;
    }
    used.add(n);
    if (Math.abs(n.bottom - h.bottom) > 0.001) out.push(`${at}: bottom ${h.bottom} -> ${n.bottom}`);
    if (Math.abs(n.swept - h.swept) > tol + 0.01 && !(n.how !== 'milled' && h.swept - h.d <= tol)) out.push(`${at}: swept Ø ${h.swept.toFixed(3)} -> ${n.swept.toFixed(3)}`);
    // Where the material starts: the old cycle's R less its margin (R2 over it); a milled hole's start as it was.
    const material = h.how === 'milled' ? h.start - 1 : h.start - (o.oldMargin ?? 2);
    if (n.start < material + (o.margin ?? 0.5) - 1e-6 && n.how !== 'milled') out.push(`${at}: starts at ${n.start}, under the material + margin (${(material + (o.margin ?? 0.5)).toFixed(3)})`);
    if (n.how === 'milled' && n.start < material - 1e-6) out.push(`${at}: starts cutting at ${n.start}, lower than ${material}`);
  }
  return out;
}
