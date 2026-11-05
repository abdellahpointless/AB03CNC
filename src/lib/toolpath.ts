import { codeOnly } from './gcodeProcessor';

/*
 * Reads a G-code program into moves for the toolpath preview, and estimates the cycle time.
 *
 * Covers what the shop's programs use: G0/G1, arcs G2/G3 (I/J or R, XY plane), absolute and
 * incremental (G90/G91), drilling and tapping cycles (G73, G74, G76, G81–G89 with G98/G99, Q
 * pecks), dwell G4, tool changes, cutter radius compensation (G41/G42 with D, G40). Moves in machine coordinates (G53, G28, G30) are counted for
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
  /** Setup (clamping) the move belongs to: a new setup starts at every G52. */
  setup: number;
  /** Cutter compensation (G41 left / G42 right of the path by r); start/end: the move that ramps it on/off. */
  comp?: { side: 1 | -1; r: number; start?: boolean; end?: boolean };
  /** The length and diameter stated for the tool in the spindle at its tool change (one T number can be another tool later on). */
  reach?: number | null;
  dia?: number | null;
}

/** A clamping of the part: the operator instructions before a G52, and its shift. */
export interface SetupRaw {
  index: number;
  /** 0-based line of its G52 (or 0 for a program without G52). */
  line: number;
  /** G52 local shift (X, Y, Z), when the program gives one. */
  shift: Vec | null;
  /** Operator instructions (M0 comments, support / spacer notes), as written in the program. */
  notes: { line: number; text: string }[];
}

export interface ToolInfo {
  tool: number;
  label: string;
  /** The operation's name written before the tool change ("TOOLPATH PLAN_16MM"), '' when none. */
  op: string;
  firstLine: number;
  seconds: number;
  /** From the "(DIAMETER 40.00 MM/LENGTH 40.00 MM)" comment, when present. */
  diameter: number | null;
  length: number | null;
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
  /** One entry per clamping of the part (always at least one). */
  setups: SetupRaw[];
  /** The program's header comments (part name and sizes). */
  header: string[];
  /** Codes the simulation does not follow (first line and how many), so the view may differ from the machine. */
  unsupported: { kind: UnsupportedKind; line: number; count: number }[];
}

/**
 * subprogram: M98/M97/M99 (Fanuc and Haas call them differently); macro: #variables, G65, IF/WHILE/GOTO;
 * offset: work offsets other than G54 (their values live in the machine); transform: G68 rotation,
 * G51 scaling/mirror; cycle: Haas pocket and circle cycles (G12/G13/G150).
 */
export type UnsupportedKind = 'subprogram' | 'macro' | 'offset' | 'transform' | 'cycle';

/** Largest gap between an arc and the straight pieces drawn for it (mm). */
export const ARC_TOLERANCE = 0.005;

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
  // The remapper's note on the tool change ("AUTO-REMAP: T6 fraise boule"): the shop's tool.
  const own = grab(lines[i]).map((c) => c.replace(/^(AUTO|APPROX|MANUAL)-REMAP:\s*T\d+\s*/i, '')).filter(Boolean)[0] ?? '';
  // The CAM's name of the tool: the comment just after the change, also on its "M01 (...)" check stop.
  let cam = '';
  for (let j = i + 1; j < Math.min(lines.length, i + 4) && !cam; j++) {
    const t = lines[j].trim().replace(/^N\d+\s*/i, '').replace(/^M0?1\s*/i, '');
    if (!t.startsWith('(')) break;
    cam = grab(t).find((c) => !/^DIAMETER\b/i.test(c)) ?? '';
  }
  if (own || cam) return own && cam ? `${own} · ${cam}` : own || cam;
  return toolOp(lines, i);
}

/** The comment just before a tool change: the operation's name ("TOOLPATH PLAN_16MM"). */
function toolOp(lines: string[], i: number): string {
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const t = lines[j].trim();
    if (!t.replace(/^N\d+\s*/i, '').startsWith('(')) break;
    const c = (t.match(/\(([^)]*)\)/) ?? [])[1]?.trim();
    if (c) return c;
  }
  return '';
}

/** Diameter and length from the comment lines right after a tool change. */
function toolSize(lines: string[], i: number): { diameter: number | null; length: number | null } {
  for (let j = i; j < Math.min(lines.length, i + 6); j++) {
    // Not past the next tool change: its comment describes that tool.
    if (j > i && /\bM0?6\b/i.test(lines[j].replace(/\([^)]*\)/g, ''))) break;
    const d = lines[j].match(/DIAMETER\s*([\d.]+)\s*MM/i);
    if (d) {
      const l = lines[j].match(/LENGTH\s*([\d.]+)\s*MM/i);
      return { diameter: Number(d[1]), length: l ? Number(l[1]) : null };
    }
  }
  const fromLabel = lines[i].match(/\bD\s*([\d.]+)/i);
  return { diameter: fromLabel ? Number(fromLabel[1]) : null, length: null };
}

/** Operator instructions that describe how the part is clamped. */
const SETUP_NOTE = /UNTERLAGE|ZWISCHENLAGE|INTERCAL|UNTERCAL|EINSPANNEN|SPANNEN|DREHEN|HOCHKANT|RAFI|TASTER|GRAD|\bIN [XYZ]|L'?\s*ET[EÉ]?AU/i;

export function parseToolpath(code: string, speeds: MachineSpeeds): Toolpath {
  const lines = code.split('\n');
  const moves: Move[] = [];
  const tools = new Map<number, ToolInfo>();
  const setups: SetupRaw[] = [{ index: 0, line: 0, shift: null, notes: [] }];
  let pendingNotes: { line: number; text: string }[] = [];
  let setup = 0;
  const header: string[] = [];

  let pos: [number | null, number | null, number | null] = [null, null, null];
  let motion = 0;
  /** Arc plane as [first, second, normal] axes: G17 XY, G18 ZX, G19 YZ. */
  let plane: [number, number, number] = [0, 1, 2];
  const unsupported = new Map<UnsupportedKind, { kind: UnsupportedKind; line: number; count: number }>();
  const flag = (kind: UnsupportedKind, line: number) => {
    const u = unsupported.get(kind);
    if (u) u.count++;
    else unsupported.set(kind, { kind, line, count: 1 });
  };
  let absolute = true;
  let feed = 0;
  let tool: number | null = null;
  let reach: number | null = null;
  let dia: number | null = null;
  let pendingTool: number | null = null;
  let toolChanges = 0;
  let cycle: number | null = null;
  let cycleR = 0;
  let cycleZ = 0;
  let cycleQ = 0;
  let returnToInitial = true;
  let initialZ = 0;
  let extraSeconds = 0;
  let compSide: 0 | 1 | -1 = 0;
  let compR = 0;
  let compStart = false;
  let compEnd = false;
  const compOf = () => (compSide ? { side: compSide, r: compR, ...(compStart ? { start: true } : {}), ...(compEnd ? { end: true } : {}) } : undefined);
  const compDone = () => {
    compStart = false;
    if (compEnd) {
      compSide = 0;
      compEnd = false;
    }
  };

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
    if (!line || line === '%') return;
    const comments = (line.match(/\(([^)]*)\)/g) ?? []).map((c) => c.slice(1, -1).replace(/^[\s(]+|[\s)]+$/g, '')).filter(Boolean);
    const commentOnly = line.replace(/^N\d+\s*/i, '').startsWith('(');
    if ((commentOnly || /^O\d+/i.test(line)) && i < 12 && !moves.length && tools.size === 0) header.push(...comments);
    // Operator instructions: comments on an M0 stop, or note lines about the support / spacer.
    const stop = /(?<![A-Z0-9])M0*0(?![0-9])/i.test(codeOnly(line));
    if (comments.length && (stop || (commentOnly && SETUP_NOTE.test(comments.join(' '))))) {
      if (!/CHECK TOOL/i.test(comments.join(' '))) pendingNotes.push({ line: i, text: comments.join(' / ') });
    }
    if (commentOnly) return;
    const { g, m, v, raw: codeText } = readWords(line);
    const has = (list: number[], ...c: number[]) => list.some((x) => c.includes(x));
    if (has(m, 97, 98, 99)) flag('subprogram', i);
    if (/#|\bIF\b|\bWHILE\b|\bGOTO/.test(codeText) || has(g, 65, 66)) flag('macro', i);
    if (g.some((c) => c >= 54.1 && c <= 59 && c !== 54) || has(g, 110, 154)) flag('offset', i);
    if (has(g, 68, 51, 51.1)) flag('transform', i);
    if (has(g, 12, 13, 150)) flag('cycle', i);
    if (has(g, 17)) plane = [0, 1, 2];
    if (has(g, 18)) plane = [2, 0, 1];
    if (has(g, 19)) plane = [1, 2, 0];

    // G52: the part was clamped again (new setup) and the zero point moves. Not a move.
    if (has(g, 52)) {
      const cur = setups[setup];
      if (cur.shift !== null || moves.some((mv) => mv.setup === setup)) {
        setup++;
        setups.push({ index: setup, line: i, shift: null, notes: [] });
      }
      setups[setup].line = i;
      setups[setup].shift = [v.get('X') ?? 0, v.get('Y') ?? 0, v.get('Z') ?? 0];
      setups[setup].notes.push(...pendingNotes);
      pendingNotes = [];
      pos = [null, null, null];
      cycle = null;
      return;
    }

    if (v.has('T')) pendingTool = v.get('T')!;
    if (has(m, 6)) {
      tool = pendingTool;
      ({ length: reach, diameter: dia } = toolSize(lines, i));
      toolChanges++;
      if (tool !== null && !tools.has(tool)) tools.set(tool, { tool, label: toolLabel(lines, i), op: toolOp(lines, i), firstLine: i, seconds: 0, ...toolSize(lines, i) });
      addTime(speeds.toolChange);
    }
    if (v.has('F')) feed = v.get('F')!;
    if (has(g, 90)) absolute = true;
    if (has(g, 91)) absolute = false;
    // Cutter compensation: the path is the part's edge; the control moves the tool off it by the
    // radius in D (the tool's own radius unless D names another tool).
    if (has(g, 41, 42)) {
      compSide = has(g, 41) ? 1 : -1;
      const d = v.get('D');
      const dia = (d !== undefined ? tools.get(d)?.diameter : null) ?? (tool !== null ? tools.get(tool)?.diameter : null) ?? 0;
      compR = dia / 2;
      compStart = true;
    }
    if (has(g, 40) && compSide) compEnd = true;
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
      moves.push({ kind: 'rapid', tool, line: i, points: [from, top], seconds: rapidTime(dist(from, top)), length: dist(from, top), setup , reach, dia });
      moves.push({ kind: 'drill', tool, line: i, points: [[x, y, cycleR]], depth: cycleZ, seconds: seconds - rapidTime(dist(from, top)), length: depth, setup , reach, dia });
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
      // Arc in the active plane (u, v) with the third axis (w) moving straight: helix. Centre from
      // I/J/K (incremental from the start) or from R. Clockwise (G2) as seen from +w.
      const [ua, va, wa] = plane;
      const IJK = ['I', 'J', 'K'];
      let cu: number;
      let cv: number;
      if (v.has(IJK[ua]) || v.has(IJK[va])) {
        cu = from[ua] + (v.get(IJK[ua]) ?? 0);
        cv = from[va] + (v.get(IJK[va]) ?? 0);
      } else if (v.has('R')) {
        const r = v.get('R')!;
        const mu = (from[ua] + end[ua]) / 2;
        const mv = (from[va] + end[va]) / 2;
        const du = end[ua] - from[ua];
        const dv = end[va] - from[va];
        const d = Math.hypot(du, dv) || 1e-9;
        const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
        // G2 with positive R: centre on the right of the chord; G3 on the left; negative R (more than a half circle) flips.
        const side = (motion === 2 ? 1 : -1) * (r >= 0 ? 1 : -1);
        cu = mu + (side * h * dv) / d;
        cv = mv - (side * h * du) / d;
      } else {
        cu = from[ua];
        cv = from[va];
      }
      const r = Math.hypot(from[ua] - cu, from[va] - cv);
      const a0 = Math.atan2(from[va] - cv, from[ua] - cu);
      let a1 = Math.atan2(end[va] - cv, end[ua] - cu);
      if (motion === 2) {
        while (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI;
      } else {
        while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
      }
      const sweep = a1 - a0;
      // Pieces short enough that the arc never strays more than ARC_TOLERANCE from them.
      const dA = r > ARC_TOLERANCE ? 2 * Math.acos(1 - ARC_TOLERANCE / r) : Math.PI / 2;
      const steps = Math.min(2000, Math.max(4, Math.ceil(Math.abs(sweep) / dA)));
      const points: Vec[] = [];
      for (let s = 0; s <= steps; s++) {
        const a = a0 + (sweep * s) / steps;
        const p: Vec = [0, 0, 0];
        p[ua] = cu + r * Math.cos(a);
        p[va] = cv + r * Math.sin(a);
        p[wa] = from[wa] + ((end[wa] - from[wa]) * s) / steps;
        points.push(p);
        grow(p);
      }
      const length = Math.hypot(r * Math.abs(sweep), end[wa] - from[wa]);
      const seconds = feedTime(length);
      moves.push({ kind: 'feed', tool, line: i, points, seconds, length, setup, comp: compOf() , reach, dia });
      compDone();
      addTime(seconds);
    } else {
      const length = dist(from, end);
      const seconds = motion === 0 ? rapidTime(length) : feedTime(length);
      grow(from);
      grow(end);
      moves.push({ kind: motion === 0 ? 'rapid' : 'feed', tool, line: i, points: [from, end], seconds, length, setup, comp: compOf() , reach, dia });
      compDone();
      addTime(seconds);
    }
    pos = end;
  });

  applyCompensation(moves);
  // Instructions without a G52 after them belong to the only setup.
  if (setups.length === 1) setups[0].notes.push(...pendingNotes);
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
    setups,
    header,
    unsupported: [...unsupported.values()],
  };
}

/**
 * Moves the tool off the programmed path for G41 (left of the direction of travel) and G42
 * (right), by the compensation radius, as the control does: corners are mitred, the G41 move
 * ramps on (starts on the path) and the G40 move ramps off (ends on the path).
 */
function applyCompensation(moves: Move[]) {
  let i = 0;
  while (i < moves.length) {
    if (!moves[i].comp || moves[i].kind === 'drill') {
      i++;
      continue;
    }
    // A block of consecutive compensated moves.
    let j = i;
    while (j + 1 < moves.length && moves[j + 1].comp && moves[j + 1].kind !== 'drill' && !moves[j + 1].comp!.start && !moves[j].comp!.end) j++;
    const block = moves.slice(i, j + 1);
    const { side, r } = block[0].comp!;
    if (r > 0) {
      // Chain of points through the block; each move's first point is the previous one's last.
      const pts: Vec[] = [block[0].points[0]];
      const owner: [number, number][][] = [[[0, 0]]];
      block.forEach((mv, b) => {
        for (let k = 1; k < mv.points.length; k++) {
          pts.push(mv.points[k]);
          owner.push([[b, k]]);
        }
        if (b + 1 < block.length) owner[owner.length - 1].push([b + 1, 0]);
      });
      const normal = (a: Vec, c: Vec): [number, number] | null => {
        const dx = c[0] - a[0];
        const dy = c[1] - a[1];
        const l = Math.hypot(dx, dy);
        return l < 1e-6 ? null : [(-dy / l) * side, (dx / l) * side];
      };
      const segN = pts.slice(1).map((p, k) => normal(pts[k], p));
      const near = (k: number, dir: -1 | 1): [number, number] | null => {
        for (let q = k; q >= 0 && q < segN.length; q += dir) if (segN[q]) return segN[q];
        return null;
      };
      const rampOn = !!block[0].comp!.start;
      const rampOff = !!block[block.length - 1].comp!.end;
      const offsets = pts.map((_, k): [number, number] => {
        if ((k === 0 && rampOn) || (k === pts.length - 1 && rampOff)) return [0, 0];
        // The ramp-on segment and the ramp-off segment do not set the direction at their ends.
        const inc = k > 0 && !(rampOn && k === 1) ? near(k - 1, -1) : null;
        const out = k < segN.length && !(rampOff && k === segN.length - 1) ? near(k, 1) : null;
        const a = inc ?? out;
        const b = out ?? inc;
        if (!a || !b) return [0, 0];
        const mx = a[0] + b[0];
        const my = a[1] + b[1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) return [a[0] * r, a[1] * r];
        const ux = mx / ml;
        const uy = my / ml;
        const scale = r / Math.max(0.25, ux * a[0] + uy * a[1]);
        return [ux * scale, uy * scale];
      });
      const moved = pts.map((p, k): Vec => [p[0] + offsets[k][0], p[1] + offsets[k][1], p[2]]);
      // New point arrays: the old points are shared with the moves around the block.
      for (const mv of block) mv.points = mv.points.slice();
      owner.forEach((refs, k) => {
        for (const [b, idx] of refs) block[b].points[idx] = moved[k];
      });
    }
    i = j + 1;
  }
}
