import type { Move, Toolpath, Vec } from './toolpath';
import { buildInput, carve, FLIP_MS, holderOf, KEPT, materialExtreme, type Grid, type SimInput } from './stockSim';
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
 *   M0 (15 MM ZWISCHENLAGE IN Y-)                   a 15 mm spacer between the part and the front jaw
 *   M0 (36 MM UNTERLAGE IN 21MM)                    36 mm parallels, holding the part 21 mm below its top
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
  /** How far below the top of the jaws the tool goes (mm); for a holder in the part, how far into it. */
  depth: number;
  /**
   * What hits: the tool (into the jaws, the default), its holder into the jaws, its holder into the
   * part, the tool into a cale (a parallel under the part: a warning, move the cale), or the tool
   * into the spacer beside it (fine: the spacer is there to be cut into; shown in green only).
   */
  what?: 'holder' | 'holderPart' | 'cale' | 'spacer';
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
  /** "UNTER MASS 5 MM": the part rests on the parallels this far above its bottom. */
  restAbove: number | null;
  /**
   * The written turn and the written position (RAFI, side up, PERS.) do not agree: the turn cannot
   * be done as written. The position is followed; the user is warned to check the flip.
   */
  conflict: boolean;
  /** "15 MM ZWISCHENLAGE IN Y-": plates between the part and a jaw (or the stop), one per side written. */
  spacers: { mm: number; side: Face }[];
  /** vise; module: the shop's modular clamp (a vise too, same 45 mm jaws); fixture: held in a fixture. */
  clamp: 'vise' | 'module' | 'fixture' | null;
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
  /**
   * The cales (parallels) under the part: where across Y they stand (machine Y, front to back)
   * and how high each reaches (the part's real underside above it). They go where the part
   * really touches the rest height, never under material that hangs lower.
   */
  cales: { y: [number, number]; top: number }[] | null;
  /** Where the supports stand (top of the vise floor / fixture plate). */
  floorZ: number | null;
  /** Top of the vise jaws (vise setups only). */
  jawTopZ: number | null;
  jawHalfWidth: number;
  /** X extent of the vise jaws: they start at the stop on the left, where the part is pushed. */
  jawX: [number, number];
  /**
   * Where the stop and the jaw plates touch the part: the machine X of its left face and the Y of
   * its front and back faces, as the part really is between the vise floor and the jaw tops.
   */
  grip: { stop: number; front: number; back: number } | null;
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
  /** Which way the white face of a top plate points in the part frame (FRONTSEITE, PERS.), when written. */
  white?: Vec | null;
}

export interface SetupOptions {
  /** Height of the vise jaws above the floor the supports stand on (mm). */
  jawHeight: number;
}

/** Thickness of the spacer on that side of the part (0 when there is none there). */
export const spacerAt = (s: { spacers: SetupInfo['spacers'] }, side: Face) => s.spacers.find((x) => x.side === side)?.mm ?? 0;

/** Floor to top of the vise jaws: the same on every vise in the shop. */
export const DEFAULT_JAW_HEIGHT = 45;
// v2: the shop's jaws are 45 mm (the first default, 42, was a guess).
export const JAW_KEY = 'cnc-toolpath-jaw-height-v2';
/** The jaw height set in the toolpath viewer (kept on this PC), or the default. */
export function readJawHeight(): number {
  try {
    const v = Number(localStorage.getItem(JAW_KEY));
    return v > 0 && v < 400 ? v : DEFAULT_JAW_HEIGHT;
  } catch {
    return DEFAULT_JAW_HEIGHT;
  }
}

const NUM = '(\\d+(?:[.,]\\d+)?)';
const num = (s: string) => Number(s.replace(',', '.'));

/** "24X26.5X10" -> [24, 26.5, 10] */
function triple(text: string | undefined): [number, number, number] | null {
  const m = text?.match(new RegExp(`${NUM}\\s*X\\s*${NUM}\\s*X\\s*${NUM}`, 'i'));
  return m ? [num(m[1]), num(m[2]), num(m[3])] : null;
}

/**
 * Finished and raw sizes from the header, e.g. "(CONTOUR INSERT ALU / 24X26.5X10 / ZUSCHNITT:28X30X20)",
 * or without the word: "(TOP PLATE POM / 100X50X30 // 104X54X40)" (two sizes: finished, then raw).
 */
export function partSizes(header: string[]): { finished: [number, number, number] | null; raw: [number, number, number] | null; name: string | null } {
  for (const h of header) {
    const parts = h.split(/ZUSCHNITT\s*:?/i);
    const finished = triple(parts[0]);
    let raw = parts.length > 1 ? triple(parts[1]) : null;
    if (finished && parts.length === 1) {
      // A second size is the raw block when it is at least as big on every side.
      const second = [...h.matchAll(new RegExp(`${NUM}\\s*X\\s*${NUM}\\s*X\\s*${NUM}`, 'gi'))][1];
      const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
      const after = second ? ([num(second[1]), num(second[2]), num(second[3])] as [number, number, number]) : null;
      if (after && sorted(after).every((v, i) => v >= sorted(finished)[i])) raw = after;
    }
    if (finished || parts.length > 1) {
      return { finished, raw, name: h.split('/')[0].trim() || null };
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
  // "104 IN X UND 54 IN Y", also written "104 UM X UND 54 UM Y".
  // "36 IN X AND 41 IN Y", "30 IN X 20.5 IN Y"; "30 IN X UND Y" and "100 IN XY": the same both ways.
  const both = t.match(new RegExp(`${NUM}\\s*(?:IN|UM)\\s*X\\s*(?:UND|AND|ET)?\\s*${NUM}\\s*(?:IN|UM)\\s*Y`));
  const xy = t.match(new RegExp(`${NUM}\\s*(?:IN|UM)\\s*(?:XY\\b|X\\s*UND\\s*Y\\b)`));
  let sizes: { x: number; y: number } | null = both ? { x: num(both[1]), y: num(both[2]) } : xy ? { x: num(xy[1]), y: num(xy[1]) } : null;
  let onlyX: number | null = null;
  let rotation: SetupInfo['rotation'] = null;
  // Turns in the order they are written: "180 GRAD UM Y", "MIT/90 IN X", "MIT 180 IN Y".
  const found: { at: number; axis: Axis; deg: number }[] = [];
  for (const m of t.matchAll(/(\d+)\s*GRAD\s*UM\s*([XYZ])/g)) found.push({ at: m.index!, axis: m[2] as Axis, deg: Number(m[1]) });
  for (const m of t.matchAll(new RegExp(`${NUM}\\s*IN\\s*([XYZ])\\b(?!\\s*(?:UND|AND|ET|\\d))`, 'g'))) {
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
  // "UNTERLAGE IN EP 5 MM", "SUR EP 8 MM", "IN EPAISEUR 20", or just "UNTERLAGE IN 21MM".
  const thick = t.match(new RegExp(`UNTERLAGE\\s*(?:(?:IN|SUR|AUF)?\\s*EP(?:AISSEUR|AISEUR)?\\.?|IN|SUR|AUF)\\s*${NUM}`));
  // The spacer pushing the part off a jaw or the stop: "15 MM ZWISCHENLAGE IN Y-", "INTERCALE 10MM Y+".
  const SPACER = '(?:ZWISCHENLAGE|INTERCAL+E?|UNTERCAL+E?)';
  // Every one written counts ("IN Y-" and "IN Y+": one plate on each side); the last one per side wins.
  const spacers = new Map<Face, number>();
  for (const re of [`${NUM}\\s*(?:MM)?\\s*${SPACER}\\s*(?:IN|EN|SUR|AUF)?\\s*([XY]\\s*[+-])`, `${SPACER}\\s*(?:DE)?\\s*${NUM}\\s*(?:MM)?\\s*(?:IN|EN|SUR|AUF)?\\s*([XY]\\s*[+-])`])
    for (const m of t.matchAll(new RegExp(re, 'g'))) spacers.set(m[2].replace(/\s/g, '') as Face, num(m[1]));
  // "ID WINDOW IN Z+": the ID window (on the white face, like the RAFI) points that way.
  // "RAF X+Y-" (O0547) is the RAFI too: missing it lets the cuts pick the flip, and they can be wrong.
  const marker = t.match(/(RAFI?|TASTER|ID\s*WINDOW)\s*(?:IN\s*)?((?:[XYZ]\s*[+-]\s*)+)/);
  // "UNTER MASS 5 MM": the part rests on a step 5 mm above its bottom (it hangs 5 mm below the parallels).
  const above = t.match(new RegExp(`UNTER\\s*MASS\\s*${NUM}`));
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
    restAbove: above ? num(above[1]) : null,
    spacers: [...spacers].map(([side, mm]) => ({ mm, side })),
    // Only clamping words say vise; "36 MM UNTERLAGE" alone keeps the fixture of the setup before.
    // "MOD. IN ALUVORRICHTUNG SPANNEN": the module holds a fixture, the part sits in that.
    // "FIXATION AVEC LES BRIDES": strap clamps on the table, no vise.
    clamp: /VORRICHT|VORRI\b|BRIDES/.test(t) ? ('fixture' as const) : /\bMOD\b|MOD\./.test(t) ? ('module' as const) : /EINSPANNEN|SPANNEN/.test(t) ? ('vise' as const) : null,
    side: /RUECKS|RÜCKS/.test(t) ? ('back' as const) : /FRONT/.test(t) ? ('front' as const) : null,
    onEdge: /HOCHKANT/.test(t),
    topToward: toward ? (toward[1].replace(/\s/g, '') as Face) : null,
    topAt: topAt ? num(topAt[1]) : null,
    marker: marker ? { name: marker[1] === 'TASTER' ? 'TASTER' : marker[1].startsWith('RAF') ? 'RAFI' : 'ID WINDOW', faces: faces(marker[2]) } : null,
  };
}

/** The value at share p of numbers already sorted. */
const percentile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];

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
/** Thickness of the stop plate at the left end of the vise jaws (mm). */
export const STOP_PLATE = 8;

/**
 * Turns of the part between setups. Explicit turns ("180 GRAD UM Y") apply to the previous
 * setup; the side that is up (RUECKS. / FRONTSEITE / PERS. on edge) and where the RAFI, TASTER or
 * ID window points must agree with them. Without a turn, the orientation that agrees with what is
 * known, nearest to the previous one, wins. When they disagree (a turn that cannot give the written
 * position), the position wins and `conflict` is set.
 */
function solveOrientation(prev: Mat3, ins: ReturnType<typeof readInstructions>, known: Map<string, Vec>): { options: Mat3[]; conflict: boolean } {
  const wants: [string, Vec][] = [];
  const front = frontDir(ins);
  if (front) wants.push(['front', front]);
  if (ins.marker) wants.push([ins.marker.name, direction(ins.marker.faces)]);
  const usable = wants.filter(([k]) => known.has(k));
  const agrees = (m: Mat3, list: [string, Vec][]) => list.every(([k, v]) => same(apply(m, known.get(k)!), v));
  // Every orientation that agrees with what is known; nearest turn first, then turning around X
  // (the usual back-to-front flip). When several agree, the cuts decide (see analyseProgram).
  const fitting = (list: [string, Vec][]) =>
    ALL.map((m, order) => {
      const d = mul(m, transpose(prev));
      return { m, score: turnSize(m, prev) * 100 + (d[0] === 1 ? 0 : d[4] === 1 ? 1 : 2) * 10 + order / 100 };
    })
      .filter(({ m }) => agrees(m, list))
      .sort((a, b) => a.score - b.score)
      .map((x) => x.m);
  // Where the written turn and position disagree, the RAFI (or TASTER, ID window) wins, then the side up.
  const byPosition = () => {
    const fits = fitting(usable);
    return fits.length ? fits : fitting(usable.filter(([k]) => k !== 'front'));
  };
  if (ins.turns.length) {
    const byTurn = ins.turns.reduce((m, r) => mul(turn(r.axis, r.deg), m), prev);
    if (agrees(byTurn, usable)) return { options: [byTurn], conflict: false };
    const fits = byPosition();
    return { options: fits.length ? fits : [byTurn], conflict: true };
  }
  if (!usable.length) return { options: [prev], conflict: false };
  const fits = fitting(usable);
  if (fits.length) return { options: fits, conflict: false };
  const fallback = byPosition();
  return { options: fallback.length ? fallback : [prev], conflict: true };
}

/**
 * "150 IN X": of the orientations left, keep those that put the part's side nearest that size
 * along X (the part may still carry raw stock, so nearest, not equal).
 */
function bySize(options: Mat3[], part: { min: Vec; max: Vec } | null, sizes: { x: number; y: number } | null): Mat3[] {
  if (options.length < 2 || !part || !sizes) return options;
  const off = (m: Mat3) => {
    const b = turnedBox(m, part.min, part.max);
    return Math.abs(b.max[0] - b.min[0] - sizes.x) + (Number.isFinite(sizes.y) ? Math.abs(b.max[1] - b.min[1] - sizes.y) : 0);
  };
  const best = Math.min(...options.map(off));
  return options.filter((m) => off(m) <= best + 1);
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
  if (fixed) return withLedges(tp, opts, new Map(fixed.map((m, i) => [i, m])), analyseWith(tp, opts, new Map(fixed.map((m, i) => [i, m]))));
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
  return withLedges(tp, opts, chosen, result);
}

/** Extra time the 3D view takes when the cales change between two setups (ms): shown slowly. */
export const CALE_MS = 2600;

/** The same cales (height and place) give the same key. */
export const calesKey = (s: SetupInfo | null): string =>
  s?.cales?.length ? `${s.support}|${s.cales.map((c) => `${c.y[0].toFixed(1)}:${c.top.toFixed(1)}`).join('/')}` : '';

/** How long the 3D view takes to turn the part from one setup to the next (ms). */
export const turnMs = (prev: SetupInfo | null, next: SetupInfo | null): number =>
  FLIP_MS + (prev && next && calesKey(prev) !== calesKey(next) ? CALE_MS : 0);

/** Width of the parallels drawn and checked under the held part (mm). */
export const parallelWidth = (holdY: number) => Math.min(6, holdY / 6);

type Box = { min: Vec; max: Vec };

/**
 * The part as it really is at each setup: after a turn, its box is the material left by the
 * setups before (from a coarse cut, made exact at the faces), not the raw block. Placement against
 * the stops, the jaws and the cales follow from that box. Then, where the part stands on a ledge
 * (a boss cut on the side before hangs down between the cales), it rests on the ledge, and each
 * cale reaches up to the part's real underside above it.
 * Each pass fixes one more setup (a box only depends on the setups before), so this settles fast.
 */
function withLedges(tp: Toolpath, opts: SetupOptions, chosen: Map<number, Mat3>, result: ProgramSetups): ProgramSetups {
  let out = result;
  let boxes = new Map<number, Box>();
  let ledges = new Map<number, number>();
  for (let pass = 0; pass <= out.setups.length; pass++) {
    const full = buildInput(tp, out);
    if (!full) return out;
    // Only what is cut before the last setup shapes any box or ledge.
    const last = out.setups[out.setups.length - 1]?.moves?.[0] ?? full.moves.length;
    const input = { ...full, moves: full.moves.map((m, i) => (i < last ? m : { ...m, points: [] })) };
    const g = carve({ ...input, maxVoxels: 100_000, surfaceMoves: false });
    /** Lowest material over each cale (front, back) at the start of setup s, in machine Z. */
    const lowest = (s: SetupInfo): [number, number] | null => {
      if (!s.stock || !s.clampBox || !s.moves) return null;
      const R = s.orient;
      const t = s.offset;
      const cb = s.clampBox;
      const w = parallelWidth(cb.max[1] - cb.min[1]);
      const a = ([0, 1, 2] as const).find((x) => R[6 + x] !== 0)!;
      const sign = R[6 + a] > 0 ? -1 : 1;
      const low = [0, 1].map((side) => {
        const v = materialExtreme(input, g, s.moves![0], a, sign, (p) => {
          const mx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
          if (mx < cb.min[0] || mx > cb.max[0]) return false;
          const my = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
          return side === 0 ? my >= cb.min[1] && my <= cb.min[1] + w : my <= cb.max[1] && my >= cb.max[1] - w;
        });
        return v === null ? Infinity : R[6 + a] * v + t[2];
      }) as [number, number];
      return Number.isFinite(low[0]) || Number.isFinite(low[1]) ? low : null;
    };
    const nextBoxes = new Map<number, Box>();
    for (const s of out.setups) {
      if (s.index === 0 || !s.moves || !s.stock) continue;
      const e = ([0, 1, 2] as const).map((a) => [materialExtreme(input, g, s.moves![0], a, -1), materialExtreme(input, g, s.moves![0], a, 1)]);
      if (e.some(([lo, hi]) => lo === null || hi === null)) continue;
      nextBoxes.set(s.index, { min: e.map((x) => x[0]!) as Vec, max: e.map((x) => x[1]!) as Vec });
    }
    const nextLedges = new Map<number, number>();
    for (const s of out.setups) {
      // Only where cales are written (the part stands on them).
      if (s.index === 0 || s.restDepth !== null || s.restAbove !== null || s.support === null) continue;
      const low = lowest(s);
      if (!low || !s.stock) continue;
      const l = Math.min(...low);
      if (Number.isFinite(l) && l > s.stock.min[2] + 1.5 && l < s.stock.max[2] - 0.5) nextLedges.set(s.index, Math.round(l * 10) / 10);
    }
    const settled = sameBoxes(boxes, nextBoxes) && nextLedges.size === ledges.size && [...nextLedges].every(([k, v]) => Math.abs((ledges.get(k) ?? NaN) - v) < 0.05);
    if (settled || pass === out.setups.length) {
      for (const s of out.setups) {
        s.cales = placeCales(s, input, g);
        s.collisions.push(...caleHits(tp, s));
        s.grip = gripOf(s, input, g);
        if (s.grip) s.jawX = [s.grip.stop - spacerAt(s, 'X-') - STOP_PLATE, s.grip.stop - spacerAt(s, 'X-') - STOP_PLATE + s.jawHalfWidth * 2];
      }
      return out;
    }
    boxes = nextBoxes;
    ledges = nextLedges;
    out = analyseWith(tp, opts, chosen, ledges, boxes);
  }
  return out;
}

/**
 * Tools that go into a cale (a parallel) under the part: below its top, over its width, along the
 * length of the jaws. One hit per run of moves of one tool, the deepest.
 */
function caleHits(tp: Toolpath, s: SetupInfo): Collision[] {
  if (!s.cales?.length || !s.moves || !s.clampBox) return [];
  const diameter = new Map(tp.tools.map((t) => [t.tool, t.diameter ?? 0]));
  const x: [number, number] = s.jawTopZ !== null ? s.jawX : [s.clampBox.min[0], s.clampBox.max[0]];
  const out: Collision[] = [];
  let open: Collision | null = null;
  for (let mi = s.moves[0]; mi <= s.moves[1]; mi++) {
    const m = tp.moves[mi];
    if (m.setup !== s.index || m.kind === 'rapid') continue;
    const r = (m.dia ?? diameter.get(m.tool ?? -1) ?? 0) / 2 || 1;
    let here: Collision | null = null;
    for (const p of samples(m)) {
      if (p[0] + r <= x[0] || p[0] - r >= x[1]) continue;
      for (const c of s.cales) {
        const depth = c.top - p[2];
        if (depth > 0.01 && p[1] + r > c.y[0] && p[1] - r < c.y[1] && (!here || depth > here.depth)) here = { move: mi, line: m.line, tool: m.tool, point: p, depth, what: 'cale' };
      }
    }
    if (!here) continue;
    if (open && open.tool === here.tool && mi - open.move <= 3) {
      if (here.depth > open.depth) Object.assign(open, { depth: here.depth, point: here.point });
    } else out.push((open = here));
  }
  return out;
}

/**
 * Where the cales go under the part at the start of setup s: from the part's real underside
 * across Y (lowest material over the held X range), a cale stands where the underside sits at the
 * rest height and nothing hangs lower over its width. The front one as far forward and the back
 * one as far back as that allows; one cale when there is only room for one.
 */
function placeCales(s: SetupInfo, input: SimInput, g: Grid): SetupInfo['cales'] {
  if (!s.stock || !s.clampBox || !s.moves || s.restZ === null || s.floorZ === null || s.restZ - s.floorZ < 0.5) return null;
  const rest = s.restZ;
  const floor = s.floorZ;
  const cb = s.clampBox;
  const R = s.orient;
  const t = s.offset;
  const before = s.moves[0];
  const w = parallelWidth(cb.max[1] - cb.min[1]);
  // Underside profile across Y (bins of 0.5 mm), from the coarse cut.
  const bw = 0.5;
  const nb = Math.max(1, Math.ceil((cb.max[1] - cb.min[1]) / bw));
  // Lowest material whose voxel lies over a bin (may hit a cale), and whose middle does (touches it).
  const under = new Float64Array(nb).fill(Infinity);
  const touchAt = new Float64Array(nb).fill(Infinity);
  const [nx, ny, nz] = g.n;
  const half: Vec = [0, 1, 2].map((r) => (Math.abs(R[r * 3]) * g.step[0] + Math.abs(R[r * 3 + 1]) * g.step[1] + Math.abs(R[r * 3 + 2]) * g.step[2]) / 2) as Vec;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (g.removed[(k * ny + j) * nx + i] < before) continue;
        const px = g.origin[0] + (i + 0.5) * g.step[0];
        const py = g.origin[1] + (j + 0.5) * g.step[1];
        const pz = g.origin[2] + (k + 0.5) * g.step[2];
        const mx = R[0] * px + R[1] * py + R[2] * pz + t[0];
        if (mx + half[0] < cb.min[0] || mx - half[0] > cb.max[0]) continue;
        const my = R[3] * px + R[4] * py + R[5] * pz + t[1];
        const mz = R[6] * px + R[7] * py + R[8] * pz + t[2] - half[2];
        const b0 = Math.max(0, Math.floor((my - half[1] - cb.min[1]) / bw));
        const b1 = Math.min(nb - 1, Math.floor((my + half[1] - cb.min[1]) / bw - 1e-9));
        for (let b = b0; b <= b1; b++) if (mz < under[b]) under[b] = mz;
        const bc = Math.floor((my - cb.min[1]) / bw);
        if (bc >= 0 && bc < nb && mz < touchAt[bc]) touchAt[bc] = mz;
      }
  const tol = half[2] * 2 + 0.2;
  const fits = (y0: number) => {
    let touch = false;
    for (let b = Math.max(0, Math.floor((y0 - cb.min[1]) / bw)); b < nb && cb.min[1] + b * bw < y0 + w; b++) {
      if (under[b] < rest - tol) return false;
      if (touchAt[b] <= rest + tol) touch = true;
    }
    return touch;
  };
  const lo = cb.min[1] + 0.3;
  const hi = cb.max[1] - 0.3 - w;
  let front: number | null = null;
  let back: number | null = null;
  for (let y = lo; y <= hi + 1e-9; y += bw) if (fits(y)) { front = y; break; }
  for (let y = hi; y >= lo - 1e-9; y -= bw) if (fits(y)) { back = y; break; }
  // Nowhere it touches at the rest height: the cales at the jaws, up to the underside above them.
  const ys = front === null || back === null ? [lo, hi] : back - front < w + 1 ? [front] : [front, back];
  const free = front === null || back === null;
  // Each cale up to the part's real underside above it (exact, not the coarse profile).
  const a = ([0, 1, 2] as const).find((x) => R[6 + x] !== 0)!;
  const sign = R[6 + a] > 0 ? -1 : 1;
  return ys.map((y0) => {
    const v = materialExtreme(input, g, before, a, sign, (p) => {
      const mx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
      if (mx < cb.min[0] || mx > cb.max[0]) return false;
      const my = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
      return my >= y0 && my <= y0 + w;
    });
    const z = v === null ? rest : R[6 + a] * v + t[2];
    const near = free ? z < rest + 3 : Math.abs(z - rest) <= tol + 0.5;
    return { y: [y0, y0 + w] as [number, number], top: near ? Math.max(floor, z) : rest };
  });
}

/** The part's real faces against the stop and the jaws (see SetupInfo.grip), at the start of setup s. */
function gripOf(s: SetupInfo, input: SimInput, g: Grid): SetupInfo['grip'] {
  if (s.jawTopZ === null || s.floorZ === null || !s.clampBox || !s.moves) return null;
  const R = s.orient;
  const t = s.offset;
  const lo = s.floorZ - 0.01;
  const hi = s.jawTopZ;
  // Only the part between the floor and the jaw tops touches them.
  const inJaws = (p: Vec) => {
    const mz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
    return mz >= lo && mz <= hi;
  };
  /** Smallest (sign -1) or largest (+1) machine coordinate along machine axis `row` of that part. */
  const reach = (row: number, sign: 1 | -1) => {
    const a = ([0, 1, 2] as const).find((x) => R[row * 3 + x] !== 0)!;
    const dir = R[row * 3 + a];
    const v = materialExtreme(input, g, s.moves![0], a, (sign * dir) as 1 | -1, inJaws);
    return v === null ? null : dir * v + t[row];
  };
  const stop = reach(0, -1);
  const front = reach(1, -1);
  const back = reach(1, 1);
  const cb = s.clampBox;
  return { stop: stop ?? cb.min[0], front: front ?? cb.min[1], back: back ?? cb.max[1] };
}

const sameBoxes = (a: Map<number, Box>, b: Map<number, Box>) =>
  a.size === b.size && [...b].every(([k, v]) => {
    const o = a.get(k);
    return !!o && [0, 1, 2].every((i) => Math.abs(o.min[i] - v.min[i]) < 0.02 && Math.abs(o.max[i] - v.max[i]) < 0.02);
  });

/** Share of setup k's cutting that falls where earlier setups already cut (coarse). */
function meetShare(tp: Toolpath, r: ProgramSetups, k: number): number {
  const input = buildInput(tp, r);
  if (!input) return 0;
  const only = (keep: (setup: number) => boolean) => ({ ...input, maxVoxels: 40_000, surfaceMoves: false, moves: input.moves.map((m) => (keep(m.setup) ? m : { ...m, points: [] })) });
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

function analyseWith(tp: Toolpath, opts: SetupOptions, override: Map<number, Mat3>, ledges?: Map<number, number>, boxes?: Map<number, Box>): ProgramSetups {
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
    // The first time a flat clamping says which side is up (RUECKS. / FRONTSEITE), the flat
    // clamping before it had the other side up: the part was turned over in between.
    if (k > 0 && ins.side && !ins.onEdge && !ins.turns.length && !known.has('front') && prev && !prev.onEdge) {
      known.set('front', apply(transpose(orient), [0, 0, ins.side === 'back' ? 1 : -1]));
    }
    const solved = k === 0 ? { options: [IDENTITY], conflict: false } : solveOrientation(orient, ins, known);
    const alternatives = bySize(solved.options, part, ins.sizes);
    orient = override.get(k) ?? alternatives[0];
    learn(orient, ins, known);
    const info: SetupInfo = {
      index: k,
      line: s.line,
      notes,
      ...ins,
      clamp: ins.clamp ?? (notes.length ? prev?.clamp ?? 'vise' : null),
      conflict: solved.conflict,
      orient,
      alternatives,
      offset: [0, 0, 0],
      clampBox: null,
      restZ: null,
      cales: null,
      stock: null,
      floorZ: null,
      jawTopZ: null,
      jawHalfWidth: 0,
      jawX: [0, 0],
      grip: null,
      collisions: [],
      jawClearance: null,
      moves: idx.length ? [idx[0], idx[idx.length - 1]] : null,
    };
    out.push(info);
    if (!moves.length || (!notes.length && !finished && !raw)) return;
    // The part as it really is now (what the setups before left of it).
    const real = boxes?.get(k);
    if (real && part) part = { min: [...real.min], max: [...real.max] };

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
    const xs = Float64Array.from(pts, (p) => p[0]).sort();
    const ys = Float64Array.from(pts, (p) => p[1]).sort();
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
      // A spacer against the stop (X-) or the fixed jaw (Y+) pushes the part away from it.
      const x = STOP_X - s.shift[0] + spacerAt(ins, 'X-') + hold[0] / 2;
      const y = STOP_Y - s.shift[1] - spacerAt(ins, 'Y+') - hold[1] / 2;
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
    // Order of trust: "IN EP" from the program, then the floor (G52 shift), then the shape.
    const support = ins.support ?? 0;
    const trusted = floorRule !== null && Math.abs(floorRule - (min[2] - support)) <= FLOOR_TRUST && floorRule <= min[2] + 1;
    let rest = min[2];
    let floor = rest - support;
    if (ins.restAbove !== null && ins.restAbove < max[2] - min[2]) {
      rest = min[2] + ins.restAbove;
      floor = trusted ? floorRule! : rest - support;
    } else if (ins.restDepth !== null && ins.restDepth < max[2] - min[2]) {
      rest = Math.max(min[2], -ins.restDepth);
      floor = trusted ? floorRule! : rest - support;
    } else if (trusted) {
      // The part sits on supports that reach the floor. When the written supports end higher than
      // the part's bottom, it rests there on a ledge (a boss hanging between the parallels).
      const top = floorRule! + support;
      if (k > 0 && ins.support !== null && top > min[2] + 1.5 && top < max[2] - 0.5) rest = top;
      floor = floorRule!;
    } else if (ledges?.has(k)) {
      rest = ledges.get(k)!;
      floor = rest - support;
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

    if (info.clamp !== 'vise' && info.clamp !== 'module') return;
    // Vise (and the modular clamp): jaws on the Y sides of the held part, from the floor up to the
    // jaw height.
    const jaw = info.clampBox;
    info.jawTopZ = info.floorZ + opts.jawHeight;
    info.jawHalfWidth = Math.max(62.5, (hold[0] + spacerAt(ins, 'X-')) / 2 + 15);
    info.jawX = [jaw.min[0] - spacerAt(ins, 'X-') - STOP_PLATE, jaw.min[0] - spacerAt(ins, 'X-') - STOP_PLATE + info.jawHalfWidth * 2];
    // The steel jaw plates: a spacer (soft, may be touched) stands between them and the part.
    const jawY: [number, number] = [jaw.min[1] - spacerAt(ins, 'Y-'), jaw.max[1] + spacerAt(ins, 'Y+')];
    let clearance = Infinity;
    // Consecutive hits of one tool (or of its holder) are one collision, the deepest.
    const open: Record<'tool' | 'holder', Collision | null> = { tool: null, holder: null };
    const add = (kind: 'tool' | 'holder', hit: Collision | null, mi: number) => {
      if (!hit) return;
      const o = open[kind];
      if (o && o.tool === hit.tool && mi - o.move <= 3) {
        if (hit.depth > o.depth) Object.assign(o, { depth: hit.depth, point: hit.point });
      } else {
        open[kind] = hit;
        info.collisions.push(hit);
      }
    };
    const over = (p: Vec, r: number) => (p[1] - r < jawY[0] || p[1] + r > jawY[1]) && p[0] + r > info.jawX[0] && p[0] - r < info.jawX[1];
    // The spacer ("ZWISCHENLAGE") between the part and a jaw or the stop, as high as the jaws.
    const spacerBoxes = ins.spacers.map((sp): [number, number, number, number] =>
      sp.side === 'Y-'
        ? [info.jawX[0], info.jawX[1], jawY[0], jaw.min[1]]
        : sp.side === 'Y+'
          ? [info.jawX[0], info.jawX[1], jaw.max[1], jawY[1]]
          : sp.side === 'X-'
            ? [jaw.min[0] - sp.mm, jaw.min[0], jaw.min[1], jaw.max[1]]
            : [0, 0, 0, 0],
    );
    const inSpacer = (p: Vec, r: number) => spacerBoxes.some((b) => p[0] + r > b[0] && p[0] - r < b[1] && p[1] + r > b[2] && p[1] - r < b[3]);
    let caleOpen: Collision | null = null;
    idx.forEach((mi) => {
      const m = tp.moves[mi];
      const r = (m.dia ?? diameter.get(m.tool ?? -1) ?? 0) / 2 || 1;
      // The holder from where the tool's stated length ends (tools without a length are not checked).
      const length = m.reach ?? 0;
      const holder = length ? holderOf(r * 2).radius : 0;
      let hitHere: Collision | null = null;
      let holderHere: Collision | null = null;
      let caleHere: Collision | null = null;
      for (const p of samples(m)) {
        if (inSpacer(p, r) && p[2] < info.jawTopZ! - 0.01 && (!caleHere || info.jawTopZ! - p[2] > caleHere.depth))
          caleHere = { move: mi, line: m.line, tool: m.tool, point: p, depth: info.jawTopZ! - p[2], what: 'spacer' };
        if (length && over(p, holder)) {
          const below = info.jawTopZ! - (p[2] + length);
          if (below > 0.01 && (!holderHere || below > holderHere.depth)) holderHere = { move: mi, line: m.line, tool: m.tool, point: [p[0], p[1], p[2] + length], depth: below, what: 'holder' };
        }
        if (!over(p, r)) continue;
        const above = p[2] - info.jawTopZ!;
        clearance = Math.min(clearance, above);
        if (above < -0.01 && (!hitHere || -above > hitHere.depth)) hitHere = { move: mi, line: m.line, tool: m.tool, point: p, depth: -above };
      }
      add('tool', hitHere, mi);
      add('holder', holderHere, mi);
      if (caleHere) {
        if (caleOpen && caleOpen.tool === caleHere.tool && mi - caleOpen.move <= 3) {
          if (caleHere.depth > caleOpen.depth) Object.assign(caleOpen, { depth: caleHere.depth, point: caleHere.point });
        } else info.collisions.push((caleOpen = caleHere));
      }
    });
    info.jawClearance = Number.isFinite(clearance) ? clearance : null;
  });
  return { setups: out, part: rawPart, white: known.get('front') ?? null };
}

export function analyseSetups(tp: Toolpath, opts: SetupOptions): SetupInfo[] {
  return analyseProgram(tp, opts).setups;
}
