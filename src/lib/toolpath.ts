import { codeOnly } from './gcodeProcessor';

/*
 * Reads a G-code program into moves for the toolpath preview, and estimates the cycle time.
 *
 * Covers what the shop's programs use: G0/G1, arcs G2/G3 (I/J or R, XY plane), absolute and
 * incremental (G90/G91), drilling and tapping cycles (G73, G74, G76, G81–G89 with G98/G99, Q
 * pecks), dwell G4, tool changes. Moves in machine coordinates (G53, G28, G30) are counted for
 * time but not drawn, since they are not in the part's coordinates.
 *
 * The time is an estimate: feeds at the programmed F, rapids at the machine's rapid rate, a fixed
 * time per tool change. Acceleration is ignored, so short moves make real times a little longer.
 */

export type Vec = [number, number, number];

export interface Move {
  kind: 'rapid' | 'feed' | 'drill';
  /** Tool number in the spindle (null before the first tool change). */
  tool: number | null;
  /** 0-based program line. */
  line: number;
  /** Points of the move: two for straight moves, more for arcs, the drill point(s) for cycles. */
  points: Vec[];
  /** Hole bottom for drilling cycles. */
  depth?: number;
  seconds: number;
  length: number;
}

export interface ToolInfo {
  tool: number;
  label: string;
  firstLine: number;
  seconds: number;
}

export interface Toolpath {
  moves: Move[];
  tools: ToolInfo[];
  min: Vec;
  max: Vec;
  totalSeconds: number;
  cuttingLength: number;
  rapidLength: number;
  toolChanges: number;
  lowestZ: number | null;
}

export interface MachineSpeeds {
  /** Rapid rate in mm/min. */
  rapid: number;
  /** Seconds per tool change. */
  toolChange: number;
}

/** Typical figures per brand (rapid rate in mm/min, tool change in seconds). */
export function speedsFor(brand: string | undefined): MachineSpeeds {
  if (brand === 'FANUC') return { rapid: 54_000, toolChange: 1.6 };
  if (brand === 'HAAS') return { rapid: 25_400, toolChange: 4.2 };
  return { rapid: 30_000, toolChange: 3 };
}

const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89]);

function readWords(line: string) {
  const code = codeOnly(line).toUpperCase();
  const g: number[] = [];
  const m: number[] = [];
  const v = new Map<string, number>();
  const re = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
  let w: RegExpExecArray | null;
  while ((w = re.exec(code))) {
    const n = Number(w[2]);
    if (w[1] === 'G') g.push(n);
    else if (w[1] === 'M') m.push(n);
    else if (!v.has(w[1])) v.set(w[1], n);
  }
  return { g, m, v, raw: code };
}

const dist = (a: Vec, b: Vec) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** The tool's description from comments on its tool-change line or right after it. */
function toolLabel(lines: string[], i: number): string {
  const grab = (l: string) => (l.match(/\(([^)]*)\)/g) ?? []).map((c) => c.slice(1, -1).trim()).filter(Boolean);
  const own = grab(lines[i]).map((c) => c.replace(/^(AUTO|APPROX|MANUAL)-REMAP:\s*T\d+\s*/i, ''));
  if (own.some(Boolean)) return own.filter(Boolean)[0];
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    const t = lines[j].trim();
    if (!t.replace(/^N\d+\s*/i, '').startsWith('(')) break;
    const c = grab(t)[0];
    if (c) return c;
  }
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const t = lines[j].trim();
    if (!t.replace(/^N\d+\s*/i, '').startsWith('(')) break;
    const c = grab(t)[0];
    if (c) return c;
  }
  return '';
}

export function parseToolpath(code: string, speeds: MachineSpeeds): Toolpath {
  const lines = code.split('\n');
  const moves: Move[] = [];
  const tools = new Map<number, ToolInfo>();

  let pos: [number | null, number | null, number | null] = [null, null, null];
  let motion = 0;
  let absolute = true;
  let feed = 0;
  let tool: number | null = null;
  let pendingTool: number | null = null;
  let toolChanges = 0;
  let cycle: number | null = null;
  let cycleR = 0;
  let cycleZ = 0;
  let cycleQ = 0;
  let returnToInitial = true;
  let initialZ = 0;
  let extraSeconds = 0;

  const min: Vec = [Infinity, Infinity, Infinity];
  const max: Vec = [-Infinity, -Infinity, -Infinity];
  const grow = (p: Vec) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  };
  const addTime = (s: number) => {
    if (tool !== null) tools.get(tool)!.seconds += s;
    else extraSeconds += s;
  };
  const rapidTime = (len: number) => (len / speeds.rapid) * 60;
  const feedTime = (len: number) => (feed > 0 ? (len / feed) * 60 : 0);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line === '%' || line.replace(/^N\d+\s*/i, '').startsWith('(')) return;
    const { g, m, v } = readWords(line);
    const has = (list: number[], ...c: number[]) => list.some((x) => c.includes(x));

    if (v.has('T')) pendingTool = v.get('T')!;
    if (has(m, 6)) {
      tool = pendingTool;
      toolChanges++;
      if (tool !== null && !tools.has(tool)) tools.set(tool, { tool, label: toolLabel(lines, i), firstLine: i, seconds: 0 });
      addTime(speeds.toolChange);
    }
    if (v.has('F')) feed = v.get('F')!;
    if (has(g, 90)) absolute = true;
    if (has(g, 91)) absolute = false;
    if (has(g, 98)) returnToInitial = true;
    if (has(g, 99)) returnToInitial = false;
    if (has(g, 4)) {
      const p = v.get('P') ?? v.get('X') ?? 0;
      addTime(/\./.test(line.match(/P\s*([-+]?\d*\.?\d+)/i)?.[1] ?? '') ? p : p / 1000);
      return;
    }

    const machineMove = has(g, 53, 28, 30);
    for (const c of g) if (c >= 0 && c <= 3) motion = c;
    if (has(g, 80)) cycle = null;
    const startCycle = g.find((c) => CYCLES.has(c));
    if (startCycle !== undefined) {
      cycle = startCycle;
      initialZ = pos[2] ?? 0;
    } else if (g.some((c) => c >= 0 && c <= 3)) cycle = null;

    const target = (axis: number, letter: string): number | null => {
      if (!v.has(letter)) return pos[axis];
      const val = v.get(letter)!;
      return absolute ? val : (pos[axis] ?? 0) + val;
    };

    // Moves in machine coordinates: time only.
    if (machineMove) {
      if (v.has('Z') && pos[2] !== null) addTime(rapidTime(Math.abs(Math.max(0, 50 - pos[2]))));
      return;
    }

    // Drilling / tapping cycle: one hole at the current (or given) X/Y.
    if (cycle !== null && (startCycle !== undefined || v.has('X') || v.has('Y'))) {
      if (v.has('R')) cycleR = absolute ? v.get('R')! : initialZ + v.get('R')!;
      if (v.has('Z')) cycleZ = absolute ? v.get('Z')! : cycleR + v.get('Z')!;
      if (v.has('Q')) cycleQ = Math.abs(v.get('Q')!);
      const x = target(0, 'X');
      const y = target(1, 'Y');
      if (x === null || y === null) return;
      const from: Vec = [pos[0] ?? x, pos[1] ?? y, pos[2] ?? initialZ];
      const top: Vec = [x, y, from[2]];
      const depth = Math.abs(cycleR - cycleZ);
      const pecks = (cycle === 83 || cycle === 73) && cycleQ > 0 ? Math.ceil(depth / cycleQ) : 1;
      const travel = dist(from, top) + Math.abs(from[2] - cycleR);
      const back = returnToInitial ? initialZ : cycleR;
      const tapping = cycle === 84 || cycle === 74;
      const seconds =
        rapidTime(travel) +
        feedTime(depth) * (tapping ? 2 : 1) +
        (cycle === 83 ? rapidTime(depth) * pecks : 0) +
        rapidTime(Math.abs(back - (tapping ? cycleR : cycleZ)));
      const hole: Vec = [x, y, cycleZ];
      grow([x, y, cycleR]);
      grow(hole);
      moves.push({ kind: 'rapid', tool, line: i, points: [from, top], seconds: rapidTime(dist(from, top)), length: dist(from, top) });
      moves.push({ kind: 'drill', tool, line: i, points: [[x, y, cycleR]], depth: cycleZ, seconds: seconds - rapidTime(dist(from, top)), length: depth });
      addTime(seconds);
      pos = [x, y, back];
      return;
    }

    if (!v.has('X') && !v.has('Y') && !v.has('Z')) return;
    const to: [number | null, number | null, number | null] = [target(0, 'X'), target(1, 'Y'), target(2, 'Z')];
    const known = pos.every((c) => c !== null) && to.every((c) => c !== null);
    if (!known) {
      // Position not fully known yet (start of program): remember, draw nothing.
      pos = [to[0] ?? pos[0], to[1] ?? pos[1], to[2] ?? pos[2]];
      if (pos.every((c) => c !== null)) grow(pos as Vec);
      return;
    }
    const from = pos as Vec;
    const end = to as Vec;

    if (motion === 2 || motion === 3) {
      // Arc in the XY plane, centre from I/J (incremental from the start) or from R.
      let cx: number;
      let cy: number;
      if (v.has('I') || v.has('J')) {
        cx = from[0] + (v.get('I') ?? 0);
        cy = from[1] + (v.get('J') ?? 0);
      } else if (v.has('R')) {
        const r = v.get('R')!;
        const mx = (from[0] + end[0]) / 2;
        const my = (from[1] + end[1]) / 2;
        const dx = end[0] - from[0];
        const dy = end[1] - from[1];
        const d = Math.hypot(dx, dy) || 1e-9;
        const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
        // G2 with positive R: centre on the right of the chord; G3 on the left; negative R flips.
        const side = (motion === 2 ? 1 : -1) * (r >= 0 ? 1 : -1);
        cx = mx + (side * h * dy) / d;
        cy = my - (side * h * dx) / d;
      } else {
        cx = from[0];
        cy = from[1];
      }
      const r = Math.hypot(from[0] - cx, from[1] - cy);
      const a0 = Math.atan2(from[1] - cy, from[0] - cx);
      let a1 = Math.atan2(end[1] - cy, end[0] - cx);
      if (motion === 2) {
        while (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI;
      } else {
        while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
      }
      const sweep = a1 - a0;
      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
      const points: Vec[] = [];
      for (let s = 0; s <= steps; s++) {
        const a = a0 + (sweep * s) / steps;
        const p: Vec = [cx + r * Math.cos(a), cy + r * Math.sin(a), from[2] + ((end[2] - from[2]) * s) / steps];
        points.push(p);
        grow(p);
      }
      const length = Math.hypot(r * Math.abs(sweep), end[2] - from[2]);
      const seconds = feedTime(length);
      moves.push({ kind: 'feed', tool, line: i, points, seconds, length });
      addTime(seconds);
    } else {
      const length = dist(from, end);
      const seconds = motion === 0 ? rapidTime(length) : feedTime(length);
      grow(from);
      grow(end);
      moves.push({ kind: motion === 0 ? 'rapid' : 'feed', tool, line: i, points: [from, end], seconds, length });
      addTime(seconds);
    }
    pos = end;
  });

  // Every move, cycle, dwell and tool change was added to its tool (or to the time before the first tool).
  const totalSeconds = [...tools.values()].reduce((s, t) => s + t.seconds, 0) + extraSeconds;
  const finite = min.every(Number.isFinite);
  return {
    moves,
    tools: [...tools.values()].sort((a, b) => a.firstLine - b.firstLine),
    min: finite ? min : [0, 0, 0],
    max: finite ? max : [0, 0, 0],
    totalSeconds,
    cuttingLength: moves.filter((mv) => mv.kind !== 'rapid').reduce((s, mv) => s + mv.length, 0),
    rapidLength: moves.filter((mv) => mv.kind === 'rapid').reduce((s, mv) => s + mv.length, 0),
    toolChanges,
    lowestZ: finite ? min[2] : null,
  };
}
