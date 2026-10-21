import type { Move, Toolpath, Vec } from './toolpath';
import { buildInput, carve, KEPT } from './stockSim';
import { ALL, IDENTITY, apply, direction, mul, rotation as turn, same, transpose, turnSize, turnedBox, type Axis, type Mat3 } from './orient';

/*
 * How the part sits in the machine in each setup, from the operator instructions written in
 * the program (German, as the CAM post-processor writes them), and whether a tool would hit the
 * vise jaws.
 *
 *   M0 (TEIL MIT 28 IN X UND 30 IN Y EINSPANNEN)   clamp the part with 28 along X, 30 along Y
 *   M0 (40 MM UNTERLAGE)                            on a 40 mm support (parallels)
 *   M0 (TEIL 180 GRAD UM Y DREHEN)                  turn the part 180° around Y (second side)
 *   M0 (MOD. SPANNEN F. RUECKS./50 IN XY)           modular fixture, back side, 50 in X and Y
 *   M0 (... /RAFI X+ Y-)                            the RAFI cut-out faces X+ and Y-
 *   G52 X.. Y.. Z..                                 zero point of this setup
 *
 * Everything is in the setup's own program coordinates (the coordinates the moves use).
 * Heights the program does not state (raw top before facing, jaw height) are estimates; the
 * jaw height is a setting of the viewer.
 */

export type Face = 'X+' | 'X-' | 'Y+' | 'Y-' | 'Z+' | 'Z-';

export interface Collision {
  /** Index in toolpath.moves. */
  move: number;
  line: number;
  tool: number | null;
  point: Vec;
  /** How far below the top of the jaws the tool goes (mm). */
  depth: number;
}

export interface SetupInfo {
  index: number;
  line: number;
  notes: string[];
  /** Instructions understood from the notes. */
  sizes: { x: number; y: number } | null;
  rotation: { axis: 'X' | 'Y' | 'Z'; deg: number } | null;
  /** Every turn the instructions ask for, in order (signed degrees, right hand). */
  turns: { axis: Axis; deg: number }[];
  /** "PERS. Y+": the front face of the part points that way (part standing on edge). */
  pers: Face | null;
  /** How the part is turned on the machine: part direction -> machine direction. */
  orient: Mat3;
  /** Other orientations the instructions allow (the first is the nearest turn). */
  alternatives: Mat3[];
  /** Machine position of the part's origin: machine = orient · part + offset. */
  offset: Vec;
  /** Where the clamp holds the part (X/Y extents, program coordinates). */
  clampBox: { min: [number, number]; max: [number, number] } | null;
  support: number | null;
  /** "UNTERLAGE IN EP 5 MM": the part rests on the parallels this far below its top (Z0). */
  restDepth: number | null;
  spacer: { mm: number; side: Face } | null;
  clamp: 'vise' | 'module' | null;
  side: 'back' | 'front' | null;
  onEdge: boolean;
  topToward: Face | null;
  /** "Z+ IN 15MM": the raw top is that far above Z0. */
  topAt: number | null;
  marker: { name: string; faces: Face[] } | null;
  /** Part block in program coordinates, when the program says enough to place it. */
  stock: { min: Vec; max: Vec } | null;
  /** Where the part sits on the parallels. */
  restZ: number | null;
  /** Where the supports stand (top of the vise floor / fixture plate). */
  floorZ: number | null;
  /** Top of the vise jaws (vise setups only). */
  jawTopZ: number | null;
  jawHalfWidth: number;
  collisions: Collision[];
  /** Lowest point of a tool that reaches over the jaws, above the jaw top (negative = into the jaws). */
  jawClearance: number | null;
  /** First and last move index of the setup. */
  moves: [number, number] | null;
}

export interface ProgramSetups {
  setups: SetupInfo[];
  /** The raw part as a box in the part's own frame (the first setup's program coordinates). */
  part: { min: Vec; max: Vec } | null;
}

export interface SetupOptions {
  /** Height of the vise jaws above the floor the supports stand on (mm). */
  jawHeight: number;
}

export const DEFAULT_JAW_HEIGHT = 42;

const NUM = '(\\d+(?:[.,]\\d+)?)';
const num = (s: string) => Number(s.replace(',', '.'));

/** "24X26.5X10" -> [24, 26.5, 10] */
function triple(text: string | undefined): [number, number, number] | null {
  const m = text?.match(new RegExp(`${NUM}\\s*X\\s*${NUM}\\s*X\\s*${NUM}`, 'i'));
  return m ? [num(m[1]), num(m[2]), num(m[3])] : null;
}

/** Finished and raw sizes from the header, e.g. "(CONTOUR INSERT ALU / 24X26.5X10 / ZUSCHNITT:28X30X20)". */
export function partSizes(header: string[]): { finished: [number, number, number] | null; raw: [number, number, number] | null; name: string | null } {
  for (const h of header) {
    const parts = h.split(/ZUSCHNITT\s*:?/i);
    const finished = triple(parts[0]);
    if (finished || parts.length > 1) {
      return { finished, raw: parts.length > 1 ? triple(parts[1]) : null, name: h.split('/')[0].trim() || null };
    }
  }
  return { finished: null, raw: null, name: null };
}

function faces(text: string): Face[] {
  return (text.toUpperCase().match(/[XYZ]\s*[+-]/g) ?? []).map((f) => f.replace(/\s/g, '') as Face);
}

/** Reads one setup's instructions. */
export function readInstructions(notes: string[]) {
  const t = notes.join(' / ').toUpperCase();
  const both = t.match(new RegExp(`${NUM}\\s*IN\\s*X\\s*UND\\s*${NUM}\\s*IN\\s*Y`));
  const xy = t.match(new RegExp(`${NUM}\\s*IN\\s*XY\\b`));
  let sizes: { x: number; y: number } | null = both ? { x: num(both[1]), y: num(both[2]) } : xy ? { x: num(xy[1]), y: num(xy[1]) } : null;
  let onlyX: number | null = null;
  let rotation: SetupInfo['rotation'] = null;
  // Turns in the order they are written: "180 GRAD UM Y", "MIT/90 IN X", "MIT 180 IN Y".
  const found: { at: number; axis: Axis; deg: number }[] = [];
  for (const m of t.matchAll(/(\d+)\s*GRAD\s*UM\s*([XYZ])/g)) found.push({ at: m.index!, axis: m[2] as Axis, deg: Number(m[1]) });
  for (const m of t.matchAll(new RegExp(`${NUM}\\s*IN\\s*([XYZ])\\b(?!\\s*UND)`, 'g'))) {
    const v = num(m[1]);
    if ([90, 180, 270].includes(v)) found.push({ at: m.index!, axis: m[2] as Axis, deg: v });
    else if (m[2] === 'X' && !sizes) onlyX = v;
  }
  found.sort((a, b) => a.at - b.at);
  // A quarter turn's direction: "X+ WIRD Y+" (X+ becomes Y+), "Z+ IN Y-" (Z+ goes to Y-).
  const hint = t.match(/([XYZ])\s*([+-])\s*(?:WIRD|IN)\s*([XYZ])\s*([+-])/);
  const turns = found.map(({ axis, deg }) => {
    if (deg % 180 !== 0 && hint) {
      const from: Vec = [0, 0, 0];
      const to: Vec = [0, 0, 0];
      from['XYZ'.indexOf(hint[1])] = hint[2] === '-' ? -1 : 1;
      to['XYZ'.indexOf(hint[3])] = hint[4] === '-' ? -1 : 1;
      if (same(apply(turn(axis, -deg), from), to)) return { axis, deg: -deg };
    }
    return { axis, deg };
  });
  if (found.length) rotation = { axis: found[0].axis, deg: found[0].deg };
  if (!sizes && onlyX !== null) sizes = { x: onlyX, y: NaN };
  const sup = t.match(new RegExp(`${NUM}\\s*MM\\s*UNTERLAGE`));
  const thick = t.match(new RegExp(`UNTERLAGE\\s*(?:IN|SUR|AUF)?\\s*(?:EP(?:AISSEUR|AISEUR)?\\.?)\\s*${NUM}`));
  const spacer = t.match(new RegExp(`${NUM}\\s*MM\\s*ZWISCHENLAGE\\s*IN\\s*([XYZ]\\s*[+-])`));
  const marker = t.match(/(RAFI|TASTER)\s*(?:IN\s*)?((?:[XYZ]\s*[+-]\s*)+)/);
  const toward = t.match(/Z\+\s*IN\s*([XY]\s*[+-])/);
  const pers = t.match(/PERS\.?\s*(?:IN\s*)?([XYZ]\s*[+-])/);
  const topAt = t.match(new RegExp(`Z\\+\\s*IN\\s*${NUM}\\s*MM`));
  return {
    sizes,
    rotation,
    turns,
    pers: pers ? (pers[1].replace(/\s/g, '') as Face) : null,
    support: sup ? num(sup[1]) : null,
    restDepth: thick ? num(thick[1]) : null,
    spacer: spacer ? { mm: num(spacer[1]), side: spacer[2].replace(/\s/g, '') as Face } : null,
    clamp: /\bMOD\b|MOD\./.test(t) ? ('module' as const) : /EINSPANNEN|SPANNEN|UNTERLAGE/.test(t) ? ('vise' as const) : null,
    side: /RUECKS|RÜCKS/.test(t) ? ('back' as const) : /FRONT/.test(t) ? ('front' as const) : null,
    onEdge: /HOCHKANT/.test(t),
    topToward: toward ? (toward[1].replace(/\s/g, '') as Face) : null,
    topAt: topAt ? num(topAt[1]) : null,
    marker: marker ? { name: marker[1] === 'TASTER' ? 'TASTER' : 'RAFI', faces: faces(marker[2]) } : null,
  };
}

const percentile = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

/** Points of a move, every ~2 mm along straight segments, the hole bottom for drilling. */
function samples(m: Move): Vec[] {
  if (m.kind === 'drill') return [m.points[0], [m.points[0][0], m.points[0][1], m.depth ?? m.points[0][2]]];
  const out: Vec[] = [];
  for (let i = 0; i < m.points.length; i++) {
    const p = m.points[i];
    if (i > 0) {
      const a = m.points[i - 1];
      const len = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
      const n = Math.min(200, Math.floor(len / 2));
      for (let k = 1; k < n; k++) out.push([a[0] + ((p[0] - a[0]) * k) / n, a[1] + ((p[1] - a[1]) * k) / n, a[2] + ((p[2] - a[2]) * k) / n]);
    }
    out.push(p);
  }
  return out;
}

const fitsIn = (t: [number, number, number] | null, a: number, b: number) => {
  if (!t) return null;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j && Math.abs(t[i] - a) < 0.6 && Math.abs(t[j] - b) < 0.6) return t[3 - i - j];
  return null;
};

/** Where the part is stopped on the table: its X- side at X-50 and its back (Y+) at Y+50 (G54). */
const STOP_X = -50;
const STOP_Y = 50;
/**
 * Where the vise floor / fixture plate is (G54 Z): the supports stand on it. Every setup of the
 * shop's programs agrees on it within a millimetre, so with the G52 Z shift it tells where the
 * part sits. Only used when it agrees with the program (within FLOOR_TRUST mm).
 */
export const TABLE_Z = -57;
const FLOOR_TRUST = 15;

/**
 * Turns of the part between setups. Explicit turns ("180 GRAD UM Y") apply to the previous
 * setup. Otherwise the side that is up (RUECKS. / FRONTSEITE / PERS. on edge) and where the RAFI
 * or TASTER points must match: the orientation that agrees with what is known, nearest to the
 * previous one, wins.
 */
function solveOrientation(prev: Mat3, ins: ReturnType<typeof readInstructions>, known: Map<string, Vec>): Mat3[] {
  if (ins.turns.length) return [ins.turns.reduce((m, r) => mul(turn(r.axis, r.deg), m), prev)];
  const wants: [string, Vec][] = [];
  const front = frontDir(ins);
  if (front) wants.push(['front', front]);
  if (ins.marker) wants.push([ins.marker.name, direction(ins.marker.faces)]);
  const usable = wants.filter(([k]) => known.has(k));
  if (!usable.length) return [prev];
  // Every orientation that agrees with what is known; nearest turn first, then turning around X
  // (the usual back-to-front flip). When several agree, the cuts decide (see analyseProgram).
  const fits = ALL.map((m, order) => {
    const d = mul(m, transpose(prev));
    return { m, score: turnSize(m, prev) * 100 + (d[0] === 1 ? 0 : d[4] === 1 ? 1 : 2) * 10 + order / 100 };
  })
    .filter(({ m }) => usable.every(([k, v]) => same(apply(m, known.get(k)!), v)))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.m);
  return fits.length ? fits : [prev];
}

function frontDir(ins: ReturnType<typeof readInstructions>): Vec | null {
  if (ins.pers) return direction([ins.pers]);
  if (ins.side === 'back') return [0, 0, -1];
  if (ins.side === 'front') return [0, 0, 1];
  return null;
}

/** Remembers the part-frame direction of the front face and of the markers seen so far. */
function learn(m: Mat3, ins: ReturnType<typeof readInstructions>, known: Map<string, Vec>) {
  const inv = transpose(m);
  const front = frontDir(ins);
  if (front && !known.has('front')) known.set('front', apply(inv, front));
  if (ins.marker && !known.has(ins.marker.name)) known.set(ins.marker.name, apply(inv, direction(ins.marker.faces)));
}

/**
 * Setups of a program. When the instructions allow more than one way to turn the part (a side
 * without RAFI, a marker seen for the first time), the way where this setup's cuts meet what
 * earlier setups cut away wins: through pockets and holes worked from both sides line up.
 * `fixed` reuses orientations found before (e.g. when only the jaw height changed).
 */
export function analyseProgram(tp: Toolpath, opts: SetupOptions, fixed?: Mat3[]): ProgramSetups {
  if (fixed) return analyseWith(tp, opts, new Map(fixed.map((m, i) => [i, m])));
  const chosen = new Map<number, Mat3>();
  let result = analyseWith(tp, opts, chosen);
  for (let k = 1; k < result.setups.length; k++) {
    const options = result.setups[k].alternatives;
    if (options.length < 2 || !result.part) continue;
    const scores = options.map((o) => {
      const r = analyseWith(tp, opts, new Map([...chosen, [k, o]]));
      return { o, r, share: meetShare(tp, r, k) };
    });
    const first = scores[0];
    const best = scores.reduce((a, b) => (b.share > a.share ? b : a));
    // Only leave the nearest turn when the cuts clearly say so.
    const pick = best.share > first.share * 1.5 && best.share - first.share > 0.02 ? best : first;
    chosen.set(k, pick.o);
    result = pick.r;
  }
  return result;
}

/** Share of setup k's cutting that falls where earlier setups already cut (coarse). */
function meetShare(tp: Toolpath, r: ProgramSetups, k: number): number {
  const input = buildInput(tp, r);
  if (!input) return 0;
  const only = (keep: (setup: number) => boolean) => ({ ...input, maxVoxels: 40_000, moves: input.moves.map((m) => (keep(m.setup) ? m : { ...m, points: [] })) });
  const before = carve(only((s) => s < k)).removed;
  const now = carve(only((s) => s === k)).removed;
  let both = 0;
  let cut = 0;
  for (let v = 0; v < now.length; v++) {
    if (now[v] === KEPT) continue;
    cut++;
    if (before[v] !== KEPT) both++;
  }
  return cut ? both / cut : 0;
}

function analyseWith(tp: Toolpath, opts: SetupOptions, override: Map<number, Mat3>): ProgramSetups {
  const { finished, raw } = partSizes(tp.header);
  const diameter = new Map(tp.tools.map((t) => [t.tool, t.diameter ?? 0]));
  const isFaceMill = (tool: number | null) => {
    const info = tp.tools.find((t) => t.tool === tool);
    return !!info && ((info.diameter ?? 0) >= 25 || /MESSERKOPF|\bMK_|PLAN/i.test(info.label));
  };
  const out: SetupInfo[] = [];
  const known = new Map<string, Vec>();
  let orient: Mat3 = IDENTITY;
  /** What is left of the part, as a box in the part frame. */
  let part: { min: Vec; max: Vec } | null = null;
  let rawPart: { min: Vec; max: Vec } | null = null;

  tp.setups.forEach((s, k) => {
    const notes = s.notes.map((n) => n.text);
    const ins = readInstructions(notes);
    const idx = tp.moves.map((m, i) => (m.setup === k ? i : -1)).filter((i) => i >= 0);
    const moves = idx.map((i) => tp.moves[i]);
    const prev = out[k - 1];
    const alternatives = k === 0 ? [IDENTITY] : solveOrientation(orient, ins, known);
    orient = override.get(k) ?? alternatives[0];
    learn(orient, ins, known);
    const info: SetupInfo = {
      index: k,
      line: s.line,
      notes,
      ...ins,
      clamp: ins.clamp ?? (notes.length ? prev?.clamp ?? 'vise' : null),
      orient,
      alternatives,
      offset: [0, 0, 0],
      clampBox: null,
      restZ: null,
      stock: null,
      floorZ: null,
      jawTopZ: null,
      jawHalfWidth: 0,
      collisions: [],
      jawClearance: null,
      moves: idx.length ? [idx[0], idx[idx.length - 1]] : null,
    };
    out.push(info);
    if (!moves.length || (!notes.length && !finished && !raw)) return;

    const faceLevels = [
      ...new Set(
        moves
          .filter((m) => m.kind === 'feed' && isFaceMill(m.tool) && m.points.length === 2 && Math.abs(m.points[0][2] - m.points[1][2]) < 1e-6)
          .map((m) => Math.round(m.points[0][2] * 1000) / 1000),
      ),
    ].sort((a, b) => b - a);
    const step = faceLevels.length > 1 ? Math.min(3, faceLevels[0] - faceLevels[1]) : 0;

    // Where the program cuts (finishing tools, not the face mill): the part is around it.
    const pts: Vec[] = [];
    const slack: number[] = [];
    for (const m of moves) {
      if (m.kind === 'rapid' || isFaceMill(m.tool)) continue;
      const add = m.kind === 'drill' ? [m.points[0]] : m.points;
      pts.push(...add);
      for (let n = 0; n < add.length; n++) slack.push((diameter.get(m.tool ?? -1) ?? 0) / 2 + 3);
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const measured = pts.length
      ? { cx: (percentile(xs, 0.05) + percentile(xs, 0.95)) / 2, cy: (percentile(ys, 0.05) + percentile(ys, 0.95)) / 2, w: percentile(xs, 0.95) - percentile(xs, 0.05), h: percentile(ys, 0.95) - percentile(ys, 0.05) }
      : { cx: 0, cy: 0, w: 0, h: 0 };
    const inside = (cx: number, cy: number, w: number, h: number) =>
      pts.length ? pts.filter((p, n) => Math.abs(p[0] - cx) <= w / 2 + slack[n] && Math.abs(p[1] - cy) <= h / 2 + slack[n]).length / pts.length : 0;

    // Size of the part on the machine (X, Y, height).
    let size: Vec | null = null;
    if (k === 0 || !part) {
      const dims = raw ?? finished;
      if (ins.sizes && Number.isFinite(ins.sizes.y)) {
        const h = fitsIn(raw, ins.sizes.x, ins.sizes.y) ?? fitsIn(finished, ins.sizes.x, ins.sizes.y) ?? dims?.[2] ?? null;
        if (h !== null) size = [ins.sizes.x, ins.sizes.y, h];
      } else if (dims) {
        let best: { score: number; p: Vec } | null = null;
        const perms: Vec[] = [
          [dims[0], dims[1], dims[2]], [dims[1], dims[0], dims[2]], [dims[0], dims[2], dims[1]],
          [dims[2], dims[0], dims[1]], [dims[1], dims[2], dims[0]], [dims[2], dims[1], dims[0]],
        ];
        const thinnest = Math.min(...dims);
        for (const p of perms) {
          if (ins.sizes && Math.abs(p[0] - ins.sizes.x) > 0.6) continue;
          // A plate clamped on its back or front lies flat.
          if (ins.side && !ins.onEdge && p[2] !== thinnest) continue;
          const score = Math.max(0, measured.w - p[0] - 2) * 10 + Math.max(0, measured.h - p[1] - 2) * 10 + Math.abs(p[0] - measured.w) + Math.abs(p[1] - measured.h);
          if (!best || score < best.score) best = { score, p };
        }
        if (best) size = best.p;
      }
    } else {
      const b = turnedBox(orient, part.min, part.max);
      size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    }
    if (!size) return;

    // The part held by the clamp: the sizes in the instruction, or the finished part on a later side.
    let hold: [number, number] = [size[0], size[1]];
    if (ins.sizes && Number.isFinite(ins.sizes.y)) hold = [ins.sizes.x, ins.sizes.y];
    else if (k > 0 && finished) {
      const f = turnedBox(orient, [0, 0, 0], finished);
      hold = [Math.min(size[0], f.max[0] - f.min[0]), Math.min(size[1], f.max[1] - f.min[1])];
    }

    // Where it sits: against the stops (from the G52 shift), else zero in the middle or on a corner.
    let cx = measured.cx;
    let cy = measured.cy;
    let placed = false;
    if (s.shift && notes.length) {
      const spacer = ins.spacer?.side === 'X-' ? ins.spacer.mm : 0;
      const x = STOP_X - s.shift[0] + spacer + hold[0] / 2;
      const y = STOP_Y - s.shift[1] - hold[1] / 2;
      if (!pts.length || inside(x, y, size[0], size[1]) >= 0.6) {
        [cx, cy] = [x, y];
        placed = true;
      }
    }
    if (!placed) {
      let best = { inside: -1, d: Infinity };
      for (const [x, y] of [[0, 0], [hold[0] / 2, -hold[1] / 2], [-hold[0] / 2, -hold[1] / 2], [hold[0] / 2, hold[1] / 2], [-hold[0] / 2, hold[1] / 2]]) {
        const share = inside(x, y, size[0], size[1]);
        const d = Math.hypot(x - measured.cx, y - measured.cy);
        if (share > best.inside + 0.02 || (Math.abs(share - best.inside) <= 0.02 && d < best.d)) {
          best = { inside: share, d };
          if (share >= 0.6 || d < 4) [cx, cy] = [x, y];
        }
      }
    }

    // Height: the raw top on the first side; later, Z0 is the finished top, so the raw top is
    // what is left to face off ("Z+ IN 15MM" says it outright).
    let topZ = faceLevels.length ? faceLevels[0] + step : 0;
    if (k > 0 && finished) {
      const f = turnedBox(orient, [0, 0, 0], finished);
      const left = size[2] - (f.max[2] - f.min[2]);
      if (left >= -0.01 && left < 20) topZ = Math.max(0, left);
    }
    if (ins.topAt !== null) topZ = ins.topAt;

    // The floor from the G52 shift. On the first side the raw part stands on the parallels, so
    // its top follows (the face-mill guess is only a guess).
    const floorRule = s.shift && notes.length ? TABLE_Z - s.shift[2] : null;
    if (floorRule !== null && k === 0 && ins.restDepth === null && ins.support !== null && ins.topAt === null) {
      const top = floorRule + ins.support + size[2];
      // Only when the guess is clearly off (more than 1.5 mm): small differences are the floor's
      // own tolerance.
      if (Math.abs(top - topZ) > 1.5 && Math.abs(top - topZ) <= FLOOR_TRUST) topZ = top;
    }

    const min: Vec = [cx - size[0] / 2, cy - size[1] / 2, topZ - size[2]];
    const max: Vec = [cx + size[0] / 2, cy + size[1] / 2, topZ];
    info.stock = { min, max };
    info.clampBox = { min: [cx - hold[0] / 2, cy - hold[1] / 2], max: [cx + hold[0] / 2, cy + hold[1] / 2] };
    // The parallels hold the part under its bottom, or under a ledge ("IN EP 5 MM": 5 mm below
    // Z0, e.g. a flange, with a boss hanging between the parallels).
    let rest = ins.restDepth !== null && ins.restDepth < max[2] - min[2] ? Math.max(min[2], -ins.restDepth) : min[2];
    let floor = rest - (ins.support ?? 0);
    if (floorRule !== null && Math.abs(floorRule - floor) <= FLOOR_TRUST && floorRule <= rest) {
      // The part sits on supports that reach the floor. When the written supports end higher than
      // the part's bottom, it rests there on a ledge (a boss hanging between the parallels).
      const top = floorRule + (ins.support ?? 0);
      if (k > 0 && ins.restDepth === null && ins.support !== null && top > min[2] + 1.5 && top < max[2] - 0.5) rest = top;
      floor = floorRule;
    }
    info.restZ = rest;
    info.floorZ = floor;

    // The part frame: the first setup's program coordinates.
    if (k === 0 || !part) {
      part = { min: [...min], max: [...max] };
      rawPart = { min: [...min], max: [...max] };
      info.orient = orient = IDENTITY;
      info.offset = [0, 0, 0];
    } else {
      const b = turnedBox(orient, part.min, part.max);
      info.offset = [min[0] - b.min[0], min[1] - b.min[1], min[2] - b.min[2]];
    }
    // What the face mill takes off: the top comes down to its last level.
    if (faceLevels.length) {
      const cut: { min: Vec; max: Vec } = { min: [...min], max: [max[0], max[1], Math.min(max[2], faceLevels[faceLevels.length - 1])] };
      const inv = transpose(orient);
      const back = turnedBox(inv, [cut.min[0] - info.offset[0], cut.min[1] - info.offset[1], cut.min[2] - info.offset[2]], [cut.max[0] - info.offset[0], cut.max[1] - info.offset[1], cut.max[2] - info.offset[2]]);
      part = back;
    }

    if (info.clamp !== 'vise') return;
    // Vise: jaws on the Y sides of the held part, from the floor up to the jaw height.
    const jaw = info.clampBox;
    info.jawTopZ = info.floorZ + opts.jawHeight;
    info.jawHalfWidth = Math.max(62.5, hold[0] / 2 + 15);
    let clearance = Infinity;
    let open: Collision | null = null;
    idx.forEach((mi) => {
      const m = tp.moves[mi];
      const r = (diameter.get(m.tool ?? -1) ?? 0) / 2 || 1;
      let hitHere: Collision | null = null;
      for (const p of samples(m)) {
        const overJaw = (p[1] - r < jaw.min[1] || p[1] + r > jaw.max[1]) && Math.abs(p[0] - cx) < info.jawHalfWidth + r;
        if (!overJaw) continue;
        const above = p[2] - info.jawTopZ!;
        clearance = Math.min(clearance, above);
        if (above < -0.01 && (!hitHere || -above > hitHere.depth)) hitHere = { move: mi, line: m.line, tool: m.tool, point: p, depth: -above };
      }
      if (hitHere) {
        if (open && open.tool === hitHere.tool && mi - open.move <= 3) {
          if (hitHere.depth > open.depth) Object.assign(open, { depth: hitHere.depth, point: hitHere.point });
        } else {
          open = hitHere;
          info.collisions.push(open);
        }
      }
    });
    info.jawClearance = Number.isFinite(clearance) ? clearance : null;
  });
  return { setups: out, part: rawPart };
}

export function analyseSetups(tp: Toolpath, opts: SetupOptions): SetupInfo[] {
  return analyseProgram(tp, opts).setups;
}
