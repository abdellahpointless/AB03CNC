import type { Tool } from '../../types';
import type { Vec } from '../toolpath';
import { ALL, IDENTITY, apply, mul, transpose, type Mat3 } from '../orient';
import { differences, layModel, modelBox, partExtent, sizeFits, voxelize, type Piece } from '../modelCompare';
import { buildInput, carve, holderHits, KEPT, shopHolder, type Grid } from '../stockSim';
import { movePath } from '../playback';
import { parseToolpath, speedsFor, type MachineSpeeds } from '../toolpath';
import { analyseProgram, jawsFrom, OVERHANG, parallelWidth, stopHits, VISE, viseSpans } from '../setups';
import { CALE_HEIGHTS } from '../cales';
import { turnPhrase } from '../fixTurns';
import { engravings, SIDES, sideFeatures, SPIN, upTurn, type Hole, type SideFeatures } from './features';
import { area, bounds, difference, inside, intersection, offset, rect, simplify, slice, turnTris, union, type P2, type Region } from './geom';
import { clearLevel, filled, swept, thinParts, trim, wallRings, type Ring } from './clear';
import { GOUGE_MM3 } from './limits';
import { arcs, shopStyle, shorten } from './style';
import { catalog, cutData, DEFAULT_LIMITS, knowledge, MILLS, toolComment, usable, type CamNote, type CamTool, type Cut, type CutEdit, type Limits, type Need } from './tools';
import type { ToolDb } from './toolDb';
import type { OpKind } from './learn';
import type { PartType } from './partType';
import { NEST, nestFor, type Nest } from './nest';
import { checkNest, checkSetup, DEFLECTION, drillThrust, wallDeflection, materialData, millForce, PARALLEL_LENGTH, PEAK, SQUEEZE, type Contact, type OpLoad, type SetupCheck } from './physics';
import { PROGRAM_MARK } from '../programMark';
import { allowedCales, blankTop, caleFor, clearOf, firstPick, firstWant, GRIP_MIN, JAW, JAW_DEPTH, TOP_MIN, underStock } from './clamp';
import { editInRange, editOpLines, keepAbove, scaleSpeeds, type OpEdit } from './opEdit';

/*
 * CAM AI: a program for a part from its 3D model, for one machine and its tools.
 *   1. The raw part: the model's box plus the shop's usual allowance (learned).
 *   2. The sides it is clamped on: the two faces of its thinnest side, then any other side
 *      needed to reach what is left (holes from the side, steps).
 *   3. Each setup: face the top, centre-drill and drill the holes, mill level by level with the
 *      largest end mill and then smaller ones where it could not reach, chamfer.
 *   4. Written like the shop's programs (header, M0 clamping in German, G52, T M6, comments).
 * The program is then read back and simulated against the model before anyone may use it.
 */

export interface CamInput {
  tris: ArrayLike<number>;
  material: string;
  tools: Tool[];
  brand?: string;
  limits?: Limits;
  name?: string;
  number?: number;
  /** Raw size along the model's X, Y, Z (null: the model plus the learned allowance). */
  raw?: Vec | null;
  /** The machine's rapid and tool change time (Admin > Machines), else its brand's. */
  speeds?: MachineSpeeds;
  /** How the part lies in the first setup (the operator's pick, see layouts.ts): the side up, turned a quarter or not. */
  orient?: { side: string; spin: boolean };
  /** The part's family (from its PDF title, confirmed by the operator): where precision matters. */
  partType?: PartType;
  /** Stock left on every wall and floor on purpose (CAM AI settings, mm; the templates' own stock is not used). */
  sideStock?: number;
  /** Template tool codes the operator does not have, and the ones picked in their place. */
  exclude?: string[];
  prefer?: string[];
  /** Sides held in the POM nest (set by camProgram when nothing else holds them), or none ever (the nest's own program). */
  nestSides?: string[];
  noNest?: boolean;
  /** The side up in setup 2, when the operator picked it on the model (else CAM AI's choice). */
  second?: string;
  /** The designer's sides for clampings 3 and on, in order (item 8): each taken after the first two, a side already
   * used or unknown left out; what is still left after them, CAM AI's as before. */
  sides?: string[];
  /** The operator's cutting values per tool code (the tool inspector). */
  cuts?: Record<string, CutEdit>;
  /** The shop's tool database (the Tool database dialog): template tools removed or with their own data, tools added. */
  toolDb?: ToolDb;
  /** Operations the operator removed (CamOp.key): left out of the program, which is simulated and checked without them. */
  skip?: string[];
  /** Faces (model triangle indices) a clamping keeps RESERVE mm off: a later clamping finishes them whole (oneClamping). */
  reserve?: { side: string; tris: number[] }[];
  /** The blank centred on the part (camProgram's fallback when no plan with it 2 mm over the part passes). */
  centred?: boolean;
  /** The designer's blank (Beta 2): this much stock on each side of the part (model frame, centred on its box), as given. */
  margins?: { lo: Vec; hi: Vec };
  /**
   * The designer's parallels (Beta 2), by clamping (first, second, ...): a height of CALE_HEIGHTS, used as given, or a note
   * says why not (clampRefused) and CAM AI's own is used; 0 for none, the part on the table the parallels stand on (you:
   * "OHNE UNTERLAGE / TEIL AUF DEM TISCH"); unset: CAM AI's own.
   */
  clamps?: (number | null)[];
  /**
   * The designer's spacer between the stop and the part (Beta 2), by clamping: 15 or 50 mm, the shop's two ("15 MM
   * ZWISCHENLAGE IN X-"; docs/knowledge V2), the part that much further from the stop; anything else is refused (stopRefused).
   */
  stops?: (number | null)[];
  /**
   * The designer's spacer in the moving jaw (Y-), by clamping: 15 mm, the shop's ("15 MM ZWISCHENLAGE IN Y-", 7 of the
   * library's 8; 20 and 50 too, the owner: "sure if needed"), from the first level on; 0: none (not even CAM AI's own);
   * anything else, or in the nest, is refused (spacerRefused). It moves nothing: the part rests on the fixed jaw and the stop.
   */
  spacersY?: (number | null)[];
  /**
   * The designer's spacer at the fixed jaw (Y+), by clamping: 15, 20 or 50 mm ("very special cases", the owner; the
   * library has none). The part rests on it, that much toward the operator: the clamping's G52 Y moves by it.
   */
  spacersYp?: (number | null)[];
  /**
   * The designer's turn of a later clamping (the owner): turned over about X or Y from the clamping before (only when
   * its side is the opposite one), then in the vise a quarter turn 1, 2 or 3 times; keyed as the other choices.
   */
  turns?: ({ flip?: 'X' | 'Y'; quarter?: 1 | 2 | 3 } | null)[];
  /**
   * The part as the operator turned it (you: +90 / -90 about the machine's X or Y, adding up), by clamping, keyed as the
   * other choices: the model -> clamping frame itself (one of the 24 turns, 9 numbers by rows), its side the one it puts
   * up. Wins over `turns` and over CAM AI's own way to lay that side; anything else is ignored.
   */
  frames?: (number[] | null)[];
  /**
   * The thickness where the parallels touch the part (you: as the engineers write it, "35 MM UNTERLAGE IN EP 8 MM"), by
   * clamping, keyed as the other choices: the depth (mm under Z0) of a step it rests on, its narrower body hanging between
   * the parallels; one of that clamping's `ledges` that fits so, else refused (stepRefused). Not asked: the deepest that fits.
   */
  steps?: (number | null)[];
  /** How holes are written (HoleOpts; the defaults when left out, `legacy` for the output before 2026-11-27). */
  holes?: HoleOpts;
  /**
   * The designer's rest on the jaw tops (you), by clamping: the depth (mm under Z0) of a face the part's wider part rests
   * on, its narrower body gripped below ("SANS CALE / EPAISSEUR DE 8 MM SUR L'ETAU"); one of that clamping's `ledges`,
   * else refused (jawRefused). Wins over `clamps` there.
   */
  jawRests?: (number | null)[];
  /**
   * The walls the operator picked to finish (shop rule: finishing only where it is asked for), as triangles of
   * `tris` (index k: the 9 numbers from 9k): the roughing leaves ALLOW on those and one pass finishes them; the
   * rest is roughed to size. None: no finishing pass. A seal cage's thin walls (under 3 mm) are finished too, gently.
   */
  finish?: number[];
  /** Who makes it (the signed-in admin), written as the programmer ("BEARBEITER"), as the shop's programs do. */
  author?: string;
  /** The machine's cooling (you: by machine, the same on every tool, never asked per tool): coolant (default) or air. */
  coolant?: 'flood' | 'air';
  /** The simpler face up in clamping 1 (CAM AI's fallback when no side was picked and the busiest face first fails the checks). */
  simplerFirst?: boolean;
  /** A top plate's white face (the operator's pick, a side name): never faced; the blank flush with it, all its stock on the other side. */
  white?: string;
  /** What is being done, as it is done: for the page's live console and 3D paths. */
  live?: (e: LiveEvent) => void;
}

/** The planner's steps (the live console) and each operation's feed moves (3D, model frame centred on its box). */
export type LiveEvent =
  | { kind: 'reset' }
  | { kind: 'stage'; stage: 'features' | 'stock' | 'setup' | 'check' | 'post'; setup?: number; of?: number; side?: string }
  | { kind: 'path'; setup: number; purpose: Purpose; pts: number[]; key: string; tool: string };

/**
 * An operation's feed moves as segments (x0 y0 z0 x1 y1 z1 ...) in its setup's frame: G01 moves,
 * and each drilled hole from its R plane down (G81/G83). CAM AI writes nothing else.
 */
export function opSegments(lines: string[]): number[] {
  const out: number[] = [];
  let [x, y, z] = [NaN, NaN, NaN];
  let feed = false;
  for (const l of lines) {
    const word = (c: string) => {
      const m = l.match(new RegExp(`${c}(-?\\d*\\.?\\d+)`));
      return m ? Number(m[1]) : null;
    };
    if (/\bG0?0\b/.test(l)) feed = false;
    else if (/\bG0?1\b/.test(l)) feed = true;
    const [nx, ny] = [word('X') ?? x, word('Y') ?? y];
    const r = word('R');
    if (r !== null) {
      // A drilling cycle line: the hole, from the R plane to its depth.
      const depth = word('Z');
      if (depth !== null) out.push(nx, ny, r, nx, ny, depth);
      [x, y] = [nx, ny];
      continue;
    }
    const nz = word('Z') ?? z;
    if (feed && [x, y, z, nx, ny, nz].every(Number.isFinite)) out.push(x, y, z, nx, ny, nz);
    [x, y, z] = [nx, ny, nz];
  }
  return out;
}

/** What an operation is for, in plain words (camAi.purpose.* on the page). */
export type Purpose = 'face' | 'centre' | 'drill' | 'pinHoles' | 'outline' | 'rough' | 'rest' | 'finish' | 'contour' | 'thinWalls' | 'chamfer' | 'engrave';

export interface CamOp {
  /** Stable name of the operation in the program (its setup's side, its name, its tool, which one of those): what the operator removes by. */
  key?: string;
  kind: OpKind;
  purpose: Purpose;
  name: string;
  tool: CamTool;
  cut: Cut;
  lines: string[];
}

export interface CamSetup {
  side: string;
  /** Model -> setup frame (p' = R p + t). */
  R: Mat3;
  t: Vec;
  notes: string[];
  shift: Vec;
  cale: number;
  /** How deep the jaws grip (mm), and what the vise does to the part with it (physics.ts). */
  grip: number;
  physics: SetupCheck;
  /** Held in the POM nest instead of the vise jaws (the nest in the vise). */
  nest?: Nest;
  /** Where precision matters, to show on the part (setup frame: outlines, from lo to hi in Z). */
  zones: Zone[];
  /** The part as held (setup frame: x0, y0, x1, y1; X along the jaws), and where the vise touches it. */
  box: [number, number, number, number];
  /** The faces the vise holds, between the parallels and the jaw tops (as box): the stop and the fixed jaw touch these. */
  held: [number, number, number, number];
  contact: Contact | null;
  ops: CamOp[];
  /** The model's chamfer triangles this clamping's FASE cut: no later clamping cuts them again. */
  chamfered?: number[];
  /** The parallels the designer may choose here (the jaws grip 3 mm or more, under the part's top, never all of it). */
  cales: number[];
  /** CAM AI's own parallels, when the designer's are used instead. */
  own?: number;
  /** Resting on the jaw tops by a face this deep under Z0 (mm), no parallels (`cale` then is how far over the table its bottom hangs). */
  onJaw?: number;
  /** The faces it could rest on the jaw tops by here (depth under Z0, mm): wider than the body the jaws grip below them. */
  ledges: number[];
  /** Resting on the parallels by the step this deep under Z0 ("UNTERLAGE IN EP"), its body hanging between them. */
  step?: number;
  /** The steps it could rest on the parallels by here (depth under Z0) and the parallels each takes. */
  steps?: { depth: number; cale: number }[];
  /** The lowest of what is left of the part here (setup frame Z). */
  bottom?: number;
  /** What the vise check was made with (its cuts aside): to check it again when an operation is edited (editProgram). */
  vise?: { material: string; length: number; width: number; height: number; grip: number; thin: number; contact: Contact | null; squeeze: number; left: number; limits: Limits; screws?: number; floor: number };
}

export interface Zone {
  kind: 'contour' | 'thinWall' | 'engraving';
  loops: P2[][];
  lo: number;
  hi: number;
}

/** Pin plates: the pins' holes are drilled a little under (Ø1, Ø2, Ø3 with the shop's 0.98, 1.97, 2.96). */
const PIN_DRILLS: [number, number][] = [[1, 0.98], [2, 1.97], [3, 2.96]];

export interface CamResult {
  code: string;
  setups: CamSetup[];
  missing: Need[];
  /** What CAM AI did not program (to do by hand or with another tool). */
  notes: CamNote[];
  size: Vec;
  raw: Vec;
  /** Where the model lies in setup 1's program coordinates (p -> R p + t): how it was planned. */
  pose: { R: Mat3; t: Vec } | null;
  /** Where the blank was planned, along the model's axes (the model centred on its box): for the 3D view. */
  blank: { lo: Vec; hi: Vec };
  /** The POM nests the part needs (the last way to hold it), each with its own program. */
  nests?: { side: string; nest: Nest; code: string; check: CamCheck }[];
  /** Through holes left closed at the far end: drilled short over the parallels, not finished from the other side. */
  short: number;
  /** Planned with the blank centred on the part (the fallback when none passes with it 2 mm over the part). */
  centred: boolean;
  /**
   * The inside corners left at a mill's radius on purpose (CORNER_R), each in its own clamping's frame: p' = M p + b
   * from setup 1's program frame, between heights z and above, in region. The check does not count them as left.
   */
  corners?: Corner[];
}
export interface Corner {
  M: Mat3;
  b: Vec;
  z: number;
  above: number;
  region: Region;
}

const TABLE_Z = -57;
const STOP_X = -50;
const STOP_Y = 50;
const SAFE = 50;
/** Stands for the machining time in the end comment until the program is checked. */
const TIME = '?.?';

const n3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
};
const mm = (v: number) => String(Math.round(v * 100) / 100);

/** Which side of the model (index in SIDES) a model axis direction is. */
const sideOf = (axis: number, sign: number) => SIDES.findIndex((s) => s.d[axis] === sign);

/** Where the part must be cut away, seen from each side (removal samples reachable from it). */
export function reachable(tris: ArrayLike<number>, lo: Vec, hi: Vec) {
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const step = Math.max(0.25, Math.cbrt((size[0] * size[1] * size[2]) / 400_000));
  const n = size.map((s) => Math.max(1, Math.ceil(s / step))) as [number, number, number];
  const g = { n, step: size.map((s, k) => s / n[k]) as Vec, origin: lo, size: step } as unknown as Grid;
  const occ = voxelize(tris, IDENTITY, [0, 0, 0], g);
  const [nx, ny, nz] = n;
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  const reach = SIDES.map(() => new Uint8Array(occ.length));
  SIDES.forEach((s, si) => {
    const a = s.d.findIndex((v) => v !== 0);
    const sign = s.d[a];
    const dims = [nx, ny, nz];
    const [u, v] = [0, 1, 2].filter((x) => x !== a);
    for (let p = 0; p < dims[u]; p++)
      for (let q = 0; q < dims[v]; q++) {
        let free = true;
        for (let w = 0; w < dims[a]; w++) {
          const c = [0, 0, 0];
          c[a] = sign > 0 ? dims[a] - 1 - w : w;
          c[u] = p;
          c[v] = q;
          const i = idx(c[0], c[1], c[2]);
          if (occ[i]) free = false;
          else if (free) reach[si][i] = 1;
        }
      }
  });
  return { occ, reach, cell: g.step[0] * g.step[1] * g.step[2], grid: g };
}

/** The cells within one cell of a filled one (26 neighbours). */
function grown(occ: Uint8Array, [nx, ny, nz]: number[]): Uint8Array {
  const out = new Uint8Array(occ.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!occ[k * nx * ny + j * nx + i]) continue;
        for (let c = Math.max(0, k - 1); c <= Math.min(nz - 1, k + 1); c++)
          for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++)
            for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) out[c * nx * ny + b * nx + a] = 1;
      }
  return out;
}

/**
 * The stock over the part on the first clamping's side, of `extra` mm of Z stock: 2 mm when 4 mm or more stay under it
 * (3 gripped, the outline 0.5 under the part and 0.5 over the jaws), else half of it, 2 at most (the shop: 2-3 mm).
 */

/**
 * The end mill to plan a clamping again with when the vise holds its biggest one's cuts only at `share` of their feed:
 * under half, the largest smaller mill whose push (about its Ø squared) it holds at half feed or more. The engineers
 * hold a tall part so (the study's, standing 70 mm tall, 37 mm deep, a Ø6 at most where CAM AI ran its Ø20).
 */
export function lighterMill(diameters: number[], used: number, share: number): number | undefined {
  if (share >= 0.5) return undefined;
  return diameters.filter((d) => d < used - 1e-6 && d <= used * Math.sqrt(share / 0.5) + 1e-6).sort((p, q) => q - p)[0];
}

/** The cale under the nest in the vise: the jaws grip its floor and the foot of its walls (about 8 mm). */
function nestCale(depth: number): number {
  const most = depth + NEST.floor - 2;
  const fits = CALE_HEIGHTS.filter((c) => JAW - c >= 5 && JAW - c <= most);
  return fits.length ? fits.reduce((b, c) => (Math.abs(JAW - c - 8) < Math.abs(JAW - b - 8) ? c : b)) : CALE_HEIGHTS[CALE_HEIGHTS.length - 1];
}

/** One end mill per Ø (the longest), largest first. */
/** Without slivers thinner than 0.3 mm (what a round tool leaves in sharp inside corners). */
const opened = (r: Region) => offset(offset(r, -0.15), 0.15);
/**
 * You: inside corners are left at the radius of the pocket mill. What a mill of this radius or less leaves only in
 * corners is not chased with a smaller one (the study: a Ø1 ran 12 minutes in 0.4 mm corner slivers 30 mm deep).
 * The shop's pocket templates go up to Ø8; the engineers' pocket mills in the study: Ø6, Ø4 only where narrower.
 */
const CORNER_R = 4;
/**
 * Of what a mill of radius r left, all but the slivers in the model's sharp corners: a piece within 0.414 r of where
 * it went, no larger than a square corner's sliver (0.215 r²: a strip along a wall is larger), with a sharp corner of
 * the model in it: a vertex of its outline (keep) turning 40° or more. A corner the model draws with a radius turns in
 * small steps (its facets): a smaller mill makes it (you, "unless the drawing asks for less").
 */
function pastCorners(left: Region, gone: Region, r: number, keep: Region): Region {
  const far = difference(left, offset(gone, 0.42 * r + 0.02));
  const sliver = 0.215 * r * r;
  const sharp: P2[] = [];
  for (const loop of keep)
    loop.forEach((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length];
      const b = loop[(i + 1) % loop.length];
      const [ux, uy, vx, vy] = [p[0] - a[0], p[1] - a[1], b[0] - p[0], b[1] - p[1]];
      const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      if (n > 1e-9 && (ux * vx + uy * vy) / n <= Math.cos((40 * Math.PI) / 180)) sharp.push(p);
    });
  const corner = (l: P2[]) => {
    const e = extent([l])!;
    if (area([l]) > 1.2 * sliver || e.hi[0] - e.lo[0] > 1.5 * r || e.hi[1] - e.lo[1] > 1.5 * r || area(intersection([l], far)) > 0.01) return false;
    // The piece stops short of the corner: the grid's skin and the 0.15 mm opening round its tip off.
    const near = offset([l], 0.6);
    return sharp.some((p) => inside(near, p) !== 0);
  };
  const outers = left.filter((l) => area([l]) > 0 && !corner(l));
  return [...outers, ...left.filter((l) => area([l]) < 0 && outers.some((o) => inside([o], l[0]) === 1))];
}
const circle = (c: [number, number], r: number) => Array.from({ length: 48 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 24), c[1] + r * Math.sin((i * Math.PI) / 24)] as P2);

/** What is left of the part, per level, in a setup's frame. */
interface Left {
  box: { lo: Vec; hi: Vec };
  /** The material between heights lo and hi (what the side of the tool sweeps down to lo). */
  at: (lo: number, hi: number) => Region;
  /** How far from the part the grid may show material that is not there (mm). */
  skin: number;
  /** How far at() grows the grid's cells (mm): the outline stands that far out of the faces. */
  grow: number;
  /** How far over the top at() shows the material may stand (mm): half a grid layer; 0 for the exact raw box. */
  above: number;
}

/**
 * A side of the grid's box or outline of what is left, put on the face it stands for: the part's own
 * or the raw block's, the one nearest where the grid puts it (less what it grew it by), within the
 * grid's reach (`skin`); else just drawn in. Left as the grid has it, a clamping's G52 and the size
 * written would sit that far off: 0.2 mm on a small part, 0.6 on a 300 mm plate.
 */
function onFace(v: number, low: boolean, faces: number[], skin: number, grown: number): number {
  const want = low ? v + grown : v - grown;
  const near = faces.filter((c) => Number.isFinite(c) && Math.abs(c - want) <= skin).sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0];
  return near ?? want;
}

/** The raw part as a box, seen from a setup. */
function boxLeft(R: Mat3, t: Vec, lo: Vec, hi: Vec): Left {
  const p = [apply(R, lo), apply(R, hi)];
  const box = { lo: [0, 1, 2].map((k) => Math.min(p[0][k], p[1][k]) + t[k]) as Vec, hi: [0, 1, 2].map((k) => Math.max(p[0][k], p[1][k]) + t[k]) as Vec };
  const r = rect(box.lo[0], box.lo[1], box.hi[0], box.hi[1]);
  return { box, at: (lo, hi) => (hi > box.lo[2] - 0.001 && lo < box.hi[2] + 0.001 ? r : []), skin: 0, grow: 0, above: 0 };
}

/**
 * What the setups so far leave of the part, simulated like the toolpath viewer does (their program
 * read back and cut on a grid), seen from the next setup (model -> its frame: p' = R p + t).
 */
/** The setups so far, read back and cut on a grid like the toolpath viewer does (setup 1's frame). */
function simulate(input: CamInput, done: CamSetup[], size: Vec, raw: Vec): Grid | null {
  const tp = parseToolpath(post(input, done, size, raw), speedsFor(input.brand));
  const an = analyseProgram(tp, { jawHeight: JAW });
  const sim = buildInput(tp, an);
  return sim ? carve({ ...sim, maxVoxels: 1_500_000, surfaceMoves: false, dropLoose: false }) : null;
}

function remaining(input: CamInput, done: CamSetup[], size: Vec, raw: Vec, R: Mat3, t: Vec): Left | null {
  const g = simulate(input, done, size, raw);
  if (!g) return null;
  // Setup 1's frame (the grid's) to this setup's: p' = M p + c.
  const R1 = done[0].R;
  const t1 = done[0].t;
  const M = mul(R, transpose(R1));
  const c = (() => {
    const q = apply(M, t1);
    return [t[0] - q[0], t[1] - q[1], t[2] - q[2]] as Vec;
  })();
  const axisOf = (row: number) => [0, 1, 2].find((k) => M[row * 3 + k] !== 0)!;
  const [ax, ay, az] = [axisOf(0), axisOf(1), axisOf(2)];
  const sign = (row: number, k: number) => M[row * 3 + k];
  const [nx, ny] = g.n;
  const at3 = (i: [number, number, number]) => i[2] * nx * ny + i[1] * nx + i[0];
  const centre = (k: number, i: number) => g.origin[k] + (i + 0.5) * g.step[k];
  // Box of what is left.
  const lo: Vec = [Infinity, Infinity, Infinity];
  const hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (let k3 = 0; k3 < g.n[2]; k3++)
    for (let j = 0; j < g.n[1]; j++)
      for (let i = 0; i < g.n[0]; i++) {
        if (g.removed[at3([i, j, k3])] !== KEPT) continue;
        const p = apply(M, [centre(0, i), centre(1, j), centre(2, k3)]);
        for (let a = 0; a < 3; a++) {
          const half = g.step[[ax, ay, az][a]] / 2;
          lo[a] = Math.min(lo[a], p[a] + c[a] - half);
          hi[a] = Math.max(hi[a], p[a] + c[a] + half);
        }
      }
  if (!Number.isFinite(lo[0])) return null;
  const cache = new Map<number, Region>();
  const layerOf = (z: number) => Math.floor(((z - c[2]) / sign(2, az) - g.origin[az]) / g.step[az]);
  const layerAt = (layer: number): Region => {
    {
      if (layer < 0 || layer >= g.n[az]) return [];
      if (cache.has(layer)) return cache.get(layer)!;
      const rects: Region = [];
      const idx: [number, number, number] = [0, 0, 0];
      idx[az] = layer;
      for (let b = 0; b < g.n[ay]; b++) {
        idx[ay] = b;
        let run = -1;
        for (let a = 0; a <= g.n[ax]; a++) {
          idx[ax] = a;
          const solid = a < g.n[ax] && g.removed[at3(idx)] === KEPT;
          if (solid && run < 0) run = a;
          if (!solid && run >= 0) {
            const x0 = sign(0, ax) * (g.origin[ax] + run * g.step[ax]) + c[0];
            const x1 = sign(0, ax) * (g.origin[ax] + a * g.step[ax]) + c[0];
            const y0 = sign(1, ay) * (g.origin[ay] + b * g.step[ay]) + c[1];
            const y1 = sign(1, ay) * (g.origin[ay] + (b + 1) * g.step[ay]) + c[1];
            rects.push(...rect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)));
            run = -1;
          }
        }
      }
      // A sample further out: the grid is coarser than the part's walls.
      const r = offset(union(rects), Math.max(g.step[ax], g.step[ay]) * 0.75);
      cache.set(layer, r);
      return r;
    }
  };
  return {
    box: { lo, hi },
    skin: Math.max(...g.step) * 1.6,
    grow: Math.max(g.step[ax], g.step[ay]) * 0.75,
    // A layer is kept when its centre was not cut: the material can stand up to half a layer over the kept ones.
    above: g.step[az] / 2,
    at: (zLo, zHi) => {
      // Every grid layer between the two heights (and the one each is in).
      const [a, b] = [layerOf(zLo), layerOf(zHi)].sort((p, q) => p - q);
      let r: Region = [];
      for (let l = Math.max(0, a); l <= Math.min(g.n[az] - 1, b); l++) r = union(r, layerAt(l));
      return r;
    },
  };
}

/** Face the top from the stock's top down to Z0. */
function facing(fm: CamTool, mat: string, limits: Limits, sb: { lo: Vec; hi: Vec }, cy: number, clear: number): CamOp {
  const cut = cutData(fm, 'face', mat, limits);
  const lines: string[] = [];
  const r = fm.diameter / 2;
  const levels: number[] = [];
  for (let z = sb.hi[2] - cut.ap; z > 0.001; z -= cut.ap) levels.push(z);
  levels.push(0);
  // Passes along the longer side; one when the face mill covers the width, else 70 % of its Ø apart.
  const along = sb.hi[0] - sb.lo[0] >= sb.hi[1] - sb.lo[1] ? 0 : 1;
  const across = 1 - along;
  const span = sb.hi[across] - sb.lo[across];
  const mid = (sb.lo[across] + sb.hi[across]) / 2;
  const count = fm.diameter * 0.8 >= span + 2 ? 1 : Math.ceil((span + 2) / (fm.diameter * 0.7)) + 1;
  const passes = count === 1 ? [mid] : Array.from({ length: count }, (_, i) => sb.lo[across] - 1 + r * 0.6 + (i * (span + 2 - r * 1.2)) / (count - 1));
  const a0 = sb.lo[along] - r - 3;
  const a1 = sb.hi[along] + r + 3;
  const xy = (a: number, b: number) => (along === 0 ? `X${n3(a)} Y${n3(b)}` : `X${n3(b)} Y${n3(a)}`);
  const A = along === 0 ? 'X' : 'Y';
  const B = along === 0 ? 'Y' : 'X';
  lines.push(`G00 G90 ${xy(a0, passes[0])} S${cut.s} M03`);
  for (const z of levels) {
    lines.push(`G00 Z${n3(z + 2)}`, `G01 Z${n3(z)} F${cut.fz}.`);
    passes.forEach((p, i) => {
      if (i) lines.push(`G01 ${B}${n3(p)}`);
      lines.push(`G01 ${A}${n3(i % 2 ? a0 : a1)} F${cut.f}.`);
    });
    lines.push(`G00 Z${n3(clear)}`, `G00 ${xy(a0, passes[0])}`);
  }
  void cy;
  return { kind: 'face', purpose: 'face', name: 'PLAN', tool: fm, cut, lines };
}

/**
 * How holes are written (the owner's rules for the VF-4, 2026-11-27): R just over where the material over each hole
 * starts, the cycle by depth and material, the holes in nearest-neighbour order, G99 where the stock proves the way
 * between two holes at R clear; `legacy` writes them as before (R 2 mm over the material, G83 always, the order read,
 * G98 always, G43 before the first move).
 */
export interface HoleOpts {
  legacy?: boolean;
  /** R this far over where the material over a hole starts (mm). */
  rMargin?: number;
  /** G81 (one feed down) up to this many Ø deep (from where the material starts). */
  g81?: number;
  /** G73 (chip-breaking pecks) up to this many Ø deep in materials with short chips; G83 (full retracts) deeper or else. */
  g73?: number;
  /** G99 between two holes where the stock proves the way at R clear. */
  g99?: boolean;
}
export const HOLE_DEFAULTS: Required<HoleOpts> = { legacy: false, rMargin: 0.5, g81: 1, g73: 3, g99: true };
/** Short chips or dust (brass, aluminium, the laminates): chip-breaking pecks; the plastics' long chips want full retracts. */
const CHIP_FRIENDLY = new Set(['ALU', 'MS', 'FH', 'EPO', 'RESOPAL']);
/** The cycle for a hole `deep` mm from where its material starts, by a drill of Ø `d`. */
export function holeCycle(deep: number, d: number, mat: string, o: Required<HoleOpts> = HOLE_DEFAULTS): { cycle: 'G81' | 'G73' | 'G83'; why: string } {
  const xd = `${mm(Math.round((deep / d) * 10) / 10)} X D`;
  // Said in words (no G or X word in a comment: readers that look for them in a line must not find them there).
  if (o.legacy) return { cycle: 'G83', why: 'AS BEFORE' };
  if (deep <= o.g81 * d + 1e-9) return { cycle: 'G81', why: `ONE FEED DOWN, ${mm(deep)} MM DEEP = ${xd} OR LESS` };
  if (deep <= o.g73 * d + 1e-9 && CHIP_FRIENDLY.has(mat)) return { cycle: 'G73', why: `CHIP BREAKING PECKS, ${mm(deep)} MM DEEP = ${xd}, SHORT CHIPS` };
  return { cycle: 'G83', why: `PECKS WITH FULL RETRACT, ${mm(deep)} MM DEEP = ${xd}` };
}
/** Holes in nearest-neighbour order from the first: less travel between them. */
export function nearestOrder<T extends { h: { c: P2 } }>(hs: T[]): T[] {
  if (hs.length < 3) return hs;
  const rest = hs.slice(1);
  const out = [hs[0]];
  while (rest.length) {
    const at = out[out.length - 1].h.c;
    let k = 0;
    for (let i = 1; i < rest.length; i++) if (dist2(rest[i].h.c, at) < dist2(rest[k].h.c, at) - 1e-9) k = i;
    out.push(rest.splice(k, 1)[0]);
  }
  return out;
}

/**
 * Centre-drill, then drill, one tool after the other. `surface`: where the material over a hole starts when it is
 * drilled. The shop drills before the pockets (143 of 157 library setups); a cycle starts over that material, never in
 * it (its way down to R is a rapid): R2 as the shop writes it (513 drill cycles) when `legacy`, else rMargin over it.
 * `clearAt(a, b, s, r)`: whether a tool of radius r goes from a to b with no material over height s on the way.
 */
export function drilling(list: { h: Hole; tool: CamTool; z: number; pin?: boolean }[], spot: CamTool | undefined, mat: string, limits: Limits, clear: number, stockTop: number, surface: (h: Hole) => number, opts: HoleOpts = {}, clearAt?: (a: P2, b: P2, s: number, r: number) => boolean, unsure?: (s: number) => number): CamOp[] {
  const o = { ...HOLE_DEFAULTS, ...opts };
  const over = o.legacy ? 2 : o.rMargin;
  // R: the margin over where the material starts, plus how far over the surface it may stand (a grid's half layer).
  const rOf = (s: number) => s + over + (o.legacy ? 0 : (unsure?.(s) ?? 0));
  const ops: CamOp[] = [];
  // Holes already there (finished from this side) need no centre; nor do holes too deep down for
  // the centre drill's holder to stay above the stock's top (drilled without one). The shop spots
  // only what it drills under 4 mm (docs/knowledge: strategy.spotSmallDrills, 1,572 of 1,636 holes).
  const fresh = list.filter((x) => x.tool.diameter < 4 && (!spot || spot.length >= stockTop - (surface(x.h) - Math.min(x.h.r, spot.diameter / 2)) + 2));
  if (spot && fresh.length) {
    const cut = cutData(spot, 'centre', mat, limits);
    const lines = [`G00 G90 X${n3(fresh[0].h.c[0])} Y${n3(fresh[0].h.c[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
    (o.legacy ? fresh : nearestOrder(fresh)).forEach(({ h }, i) => {
      const s = surface(h);
      const z = s - Math.min(h.r, spot.diameter / 2) * 0.8;
      lines.push(i ? `X${n3(h.c[0])} Y${n3(h.c[1])} Z${n3(z)} R${n3(rOf(s))}` : `G98 G81 X${n3(h.c[0])} Y${n3(h.c[1])} Z${n3(z)} R${n3(rOf(s))} F${cut.fz}.`);
    });
    lines.push('G80');
    ops.push({ kind: 'centre', purpose: 'centre', name: 'ZENTRIERBOHREN', tool: spot, cut, lines });
  }
  const byTool = new Map<CamTool, { h: Hole; z: number }[]>();
  for (const { h, tool, z } of list) (byTool.get(tool) ?? byTool.set(tool, []).get(tool)!).push({ h, z });
  for (const [tool, all] of byTool) {
    const cut = cutData(tool, 'drill', mat, limits);
    const hs = o.legacy ? all : nearestOrder(all);
    const lines = [`G00 G90 X${n3(hs[0].h.c[0])} Y${n3(hs[0].h.c[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
    const rows = hs.map(({ h, z }) => {
      const s = surface(h);
      return { h, z, s, ...holeCycle(s - z, tool.diameter, mat, o) };
    });
    // Each hole's cycle and why (the owner's rule), before the drilling.
    if (!o.legacy) rows.forEach((r, i) => lines.push(`(HOLE ${i + 1} AT ${n3(r.h.c[0])}/${n3(r.h.c[1])}: ${r.why})`));
    let before = 'G98';
    rows.forEach((r, i) => {
      const next = rows[i + 1];
      // Back to R only where the way on to the next hole at R is proven clear (else to the start height).
      const back = !o.legacy && o.g99 && next && clearAt?.(r.h.c, next.h.c, r.s, tool.diameter / 2) ? 'G99' : 'G98';
      // After a hole that stayed at R, a control may take R as the start height a G98 goes back to: over this hole at
      // R (that way is proven), up, the cycle again from there, so the way on is at the start height however it is read.
      if (back === 'G98' && before === 'G99' && next) lines.push('G80', `G00 X${n3(r.h.c[0])} Y${n3(r.h.c[1])}`, `G00 Z${n3(clear)}`);
      before = back;
      const q = r.cycle === 'G81' ? '' : ` Q${n3(Math.min(cut.q, r.s - r.z))}`;
      lines.push(`${back} ${r.cycle} X${n3(r.h.c[0])} Y${n3(r.h.c[1])} Z${n3(r.z)} R${n3(rOf(r.s))}${q} F${cut.fz}.`);
    });
    lines.push('G80');
    ops.push({ kind: 'drill', purpose: list.some((x) => x.tool === tool && x.pin) ? 'pinHoles' : 'drill', name: `BOHREN_${mm(tool.diameter)}MM`, tool, cut, lines });
  }
  return ops;
}

/**
 * How steeply an end mill ramps into material (it never plunges straight into it): 15° in the SF Ø
 * range per material where the shop's engineers go in that steeply (15-20° ramps or straight plunges,
 * in two programs or more of the library), else 5°. The high-feed mills (SFH), the mills over Ø8 and
 * the smallest ones never go into material in the library (they go down beside it).
 */
const STEEP: Partial<Record<string, [number, number]>> = { ALU: [2, 8], FH: [3, 8], PCGF: [1, 8], PEEK: [2, 4], POM: [3, 8], RESOPAL: [3, 8] };
const steepOf = (tool: CamTool, mat: string) => {
  const s = STEEP[mat];
  // Only the shop's own (template) mills: a machine's mill without one has nothing in the library to go by (a review finding).
  return tool.type === 'SF' && !!tool.template && !!s && tool.diameter >= s[0] - 1e-6 && tool.diameter <= s[1] + 1e-6;
};
const rampOf = (tool: CamTool, mat: string) => Math.tan(((steepOf(tool, mat) ? 15 : 5) * Math.PI) / 180);
/** You: those mills go straight down into POM, FH and RESOPAL (the engineers' 2 mm plunges at the entry feed), not into the others. */
const PLUNGES = new Set(['POM', 'FH', 'RESOPAL']);
/**
 * How deep they go straight into material: the engineers' plunges (Z-1.75 to Z-3.75, Z2 to Z-2), a deeper pass ramping
 * the rest; in POM a whole pass (you).
 */
const plungeMm = (mat: string) => (mat === 'POM' ? Infinity : 2);
const plungesInto = (tool: CamTool, mat: string) => PLUNGES.has(mat) && steepOf(tool, mat);
type P3 = [number, number, number];
const dist2 = (a: P2, b: P2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Down from z0 to z1 at `slope` (dz per mm) from `start`, through the vertices `next(k)` gives
 * (k = 0, 1, …): the points passed, where it ends, and the vertex it was heading for.
 */
function ramp(start: P2, next: (k: number) => P2, z0: number, z1: number, slope: number): { pts: P3[]; end: P2; k: number } {
  const L = Math.max(0.01, (z0 - z1) / slope);
  const pts: P3[] = [];
  let p = start;
  let s = 0;
  for (let k = 0; k < 1_000_000; k++) {
    const q = next(k);
    const d = dist2(p, q);
    if (s + d >= L) {
      const t = d > 1e-9 ? (L - s) / d : 0;
      const end: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      pts.push([end[0], end[1], z1]);
      return { pts, end, k };
    }
    s += d;
    pts.push([q[0], q[1], z0 - ((z0 - z1) * s) / L]);
    p = q;
  }
  return { pts, end: p, k: 0 };
}

/**
 * Down from z0 to z1 back and forth over an open piece's first stretch, at `slope`: there and back over as
 * much of it as the ramp still needs (the whole piece, then a shorter stretch, when it is shorter). It ends
 * at the piece's start at z1, where the pass along it begins (the shop's zigzag: no walk back), no longer
 * than the ramp needs.
 */
export function zigzag(pts: P2[], z0: number, z1: number, slope: number): P3[] {
  const need = Math.max(0.01, (z0 - z1) / slope);
  const whole = pts.reduce((t, p, i) => (i ? t + dist2(pts[i - 1], p) : 0), 0);
  // The vertices within D of the start, and the point at D.
  const stretch = (D: number): P2[] => {
    const there: P2[] = [pts[0]];
    for (let i = 1, s = 0; i < pts.length; i++) {
      const d = dist2(pts[i - 1], pts[i]);
      if (s + d >= D - 1e-9) {
        const t = d > 1e-9 ? (D - s) / d : 0;
        there.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
        break;
      }
      there.push(pts[i]);
      s += d;
    }
    return there;
  };
  const out: P3[] = [];
  let [s, p, rest] = [0, pts[0], need];
  while (rest > 1e-6 && whole > 1e-9) {
    const there = stretch(Math.min(whole, rest / 2));
    for (const q of [...there.slice(1), ...there.slice(0, -1).reverse()]) {
      s += dist2(p, q);
      p = q;
      out.push([q[0], q[1], z0 - ((z0 - z1) * Math.min(s, need)) / need]);
    }
    rest = need - s;
  }
  if (out.length) out[out.length - 1][2] = z1;
  return out;
}

const perimeter = (g: Ring) => g.pts.reduce((t, p, i) => (i || g.closed ? t + dist2(g.pts[i ? i - 1 : g.pts.length - 1], p) : t), 0);

/** One level of an end mill: its rings, the level's bottom and top, and the part there (never touched). */
interface Work {
  z: number;
  above: number;
  rings: Ring[];
  keep: Region;
  /** Rings already cut at this level by an earlier operation (finishing enters from the roughing's). */
  done?: Ring[];
  /** Below the jaws: pockets only. Thin walls here (a seal cage's, under THIN mm). */
  inside?: boolean;
  thin?: Region;
  /** Its walls get a finishing pass. */
  finish?: boolean;
  /** Where its walls are finished, seen from the top: along the picked walls and a seal cage's thin ones. */
  zone?: Region;
}

/** The spacer the shop puts in the moving jaw (mm; docs/knowledge: 15 mm at Y- in 4 programs, 20 in 1). */
const SPACER_Y = 15;
/** The spacers the designer may put in a jaw (mm): the shop's 15 (and 20 and 50 when needed, the owner). */
const SPACERS_Y = [15, 20, 50] as const;
/** Radial stock the roughing leaves on the walls for the finishing (mm). */
const ALLOW = 0.15;
/** A seal cage's walls thinner than this are cut gently (mm). */
const THIN = 3;
/** The families whose precise contour is shown on the part (zones). */
const PRECISE: PartType[] = ['topPlate', 'contourInsert', 'sealCage'];

/** Thickness of the thinnest wall in a region (twice the deepest it can be shrunk). */
function thickness(region: Region): number {
  let lo = 0;
  let hi = THIN / 2;
  for (let i = 0; i < 8; i++) {
    const m = (lo + hi) / 2;
    if (area(offset(region, -m)) > 0.01) lo = m;
    else hi = m;
  }
  return Math.max(0.2, 2 * lo);
}

/**
 * Where a ring can be entered from the side: from a ring already cut down to this level (its path
 * is clear to the bottom), the nearest pair of points no more than two step-overs apart, the
 * straight move between them clear of the part.
 */
function sideEntry(g: Ring, done: Ring[], r: number, ae: number, keep: Region): { from: P2; at: number } | null {
  let best: { from: P2; at: number; d: number } | null = null;
  // An open piece is entered at one of its ends (it is cut from there), a closed ring anywhere.
  const at = g.closed ? g.pts.map((_, i) => i) : [0, g.pts.length - 1];
  for (const o of done)
    for (const p of o.pts)
      for (const i of at) {
        const d = dist2(p, g.pts[i]);
        if (d <= 2 * ae + 0.5 && (!best || d < best.d)) best = { from: p, at: i, d };
      }
  if (!best) return null;
  const b: { from: P2; at: number; d: number } = best;
  // The tool sweeping straight across must not touch what stays.
  if (area(intersection(swept([{ pts: [b.from, g.pts[b.at]], closed: false, outside: false }], r - 0.03), keep)) > 0.001) return null;
  return { from: b.from, at: b.at };
}

/**
 * You (Beta 2): one place finished to its bottom before the same mill goes to the next, not a level of each in
 * turn. The rings grouped by where they lie seen from the top (what the tool sweeps; a ring that touches two
 * places joins them, cut level by level then), each group top down. `fresh`: a group's first level.
 */
export function byPlace(work: Work[], r: number): (Work & { fresh?: boolean })[] {
  type Group = { foot: Region; box: number[]; items: { w: Work; ring: Ring; i: number }[] };
  const groups: Group[] = [];
  const meet = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const join = (a: number[], b: number[]) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  let i = 0;
  for (const w of work)
    for (const ring of w.rings) {
      const box = ring.pts.reduce((b, p) => [Math.min(b[0], p[0] - r), Math.min(b[1], p[1] - r), Math.max(b[2], p[0] + r), Math.max(b[3], p[1] + r)], [Infinity, Infinity, -Infinity, -Infinity]);
      const foot = swept([ring], r);
      const hit = groups.filter((g) => meet(g.box, box) && area(intersection(g.foot, foot)) > 1e-3);
      let g = hit[0];
      if (!g) groups.push((g = { foot: [], box, items: [] }));
      for (const o of hit.slice(1)) {
        g.items.push(...o.items);
        g.foot = union(g.foot, o.foot);
        g.box = join(g.box, o.box);
        groups.splice(groups.indexOf(o), 1);
      }
      g.items.push({ w, ring, i: i++ });
      g.foot = union(g.foot, foot);
      g.box = join(g.box, box);
    }
  return groups.flatMap((g) => {
    const out: (Work & { fresh?: boolean; from: Work })[] = [];
    for (const it of g.items.sort((p, q) => q.w.z - p.w.z || p.i - q.i)) {
      const last = out[out.length - 1];
      if (last?.from === it.w) last.rings.push(it.ring);
      else out.push({ ...it.w, rings: [it.ring], from: it.w, fresh: !out.length });
    }
    return out;
  });
}

/**
 * An end mill's rings, level by level, top down. Each ring is run in passes no deeper than the
 * tool's own depth per pass (its ring is clear of the part at every height above its level).
 * It never plunges into material: the first ring of a level ramps down along itself (a closed
 * one round and round, an open one back and forth), straight down only where its whole circle is
 * in the air (`material`: what is there between two heights at the start of the setup). Every
 * next ring is entered from the side, out of a ring already cut to the bottom (sideEntry): down
 * in that ring's path by rapid to 1 mm above the pass, across, round, and lifted and over by
 * rapid for an open piece's next pass (never back over the cut at feed).
 */
/**
 * A closed ring that is a circle smaller than the tool (a hole a little wider than the mill: the owner's "micro loop"),
 * every point within 0.005 mm of it: its centre (a least-squares fit), radius and way round; else null.
 */
export function microCircle(pts: P2[], toolR: number): { c: P2; r: number; ccw: boolean } | null {
  const n = pts.length;
  if (n < 6) return null;
  // Kasa fit: x² + y² + D x + E y + F = 0 by least squares (normal equations, 3 x 3).
  let [sx, sy, sxx, syy, sxy, sz, sxz, syz] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const b = [-sxz, -syz, -sz];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(A);
  if (Math.abs(d0) < 1e-12) return null;
  const col = (k: number) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const [D, E, F] = [det(col(0)) / d0, det(col(1)) / d0, det(col(2)) / d0];
  const c: P2 = [-D / 2, -E / 2];
  const r = Math.sqrt(Math.max(0, c[0] * c[0] + c[1] * c[1] - F));
  if (r < 0.005 || r >= toolR || pts.some((p) => Math.abs(dist2(p, c) - r) > 0.005)) return null;
  let a = 0;
  for (let i = 0; i < n; i++) a += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  return { c, r, ccw: a > 0 };
}

function milling(tool: CamTool, planned: Work[], mat: string, limits: Limits, stockTop: number, clear: number, material: (lo: number, hi: number) => Region, purpose: Purpose, upTo?: (ring: Ring, z: number) => number | null, raised?: (ring: Ring, z: number, top: number) => void, helix = false): CamOp {
  const finish = purpose === 'finish' || purpose === 'contour' || purpose === 'thinWalls';
  // Each ring with as few points as keep its own within 0.005 mm (finishing 0.002), not every facet and
  // step of the model's curves (CAM AI wrote 27 % of its roughing moves under 0.01 mm, the shop 2 %).
  // The roughing's rings a finishing enters from, as the roughing wrote them.
  const fewer = (tol: number) => (g: Ring): Ring => ({ ...g, pts: simplify(g.pts, tol, g.closed) });
  const work = byPlace(planned.map((w) => ({ ...w, rings: w.rings.map(fewer(finish ? 0.002 : 0.005)), done: w.done?.map(fewer(0.005)) })), tool.diameter / 2);
  const cut = cutData(tool, finish ? 'finish' : 'pocket', mat, limits);
  // Round the outside the tool takes at most a step-over of material: the shop's contour depths
  // (much deeper than in a pocket, where the first ring is a full slot). Finishing: one cut.
  const side = finish ? cut : cutData(tool, 'contour', mat, limits);
  // A thin wall (seal cage): half the depth, 70 % of the feed, the spindle 20 % faster (a thinner
  // chip, less push on the wall).
  // And the wall (t thick, the cut's depth high, as wide as the cut) must not bend over 0.01 mm
  // under it: slower still if it would (physics.ts).
  const gentle = (c: Cut, t: number): Cut => {
    const ap = Math.max(0.2, Math.round(c.ap * 50) / 100);
    const s = Math.min(limits.maxRpm, Math.round((c.s * 1.2) / 50) * 50);
    let k = 0.7;
    const { kc, E } = materialData(mat);
    const bend = wallDeflection(PEAK * millForce(kc, ap, c.ae, c.f * k, s, tool.diameter), ap, t, Math.max(ap, tool.diameter), E);
    if (bend > DEFLECTION.finish) k = Math.max(0.3 * 0.7, (k * DEFLECTION.finish) / bend);
    return { ...c, ap, s, f: Math.max(10, Math.round((c.f * k) / 10) * 10), fz: Math.max(10, Math.round((c.fz * k) / 10) * 10) };
  };
  const r = tool.diameter / 2;
  const slope = rampOf(tool, mat);
  const straight = plungesInto(tool, mat);
  const airCache = new Map<string, Region>();
  const inAir = (p: P2, lo: number, hi: number) => {
    const key = `${lo.toFixed(3)}:${hi.toFixed(3)}`;
    let m = airCache.get(key);
    if (!m) airCache.set(key, (m = offset(material(lo, hi), r - 0.05)));
    return inside(m, p) === 0;
  };
  const xy = (p: P2) => `X${n3(p[0])} Y${n3(p[1])}`;
  const xyz = (p: P3) => `X${n3(p[0])} Y${n3(p[1])} Z${n3(p[2])}`;
  const first = work[0].rings[0].pts[0];
  const lines = [`G00 G90 X${n3(first[0])} Y${n3(first[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
  let rpm = cut.s;
  let prevZ = stockTop;
  for (const { z, above, rings, keep, done: before, fresh } of work) {
    // A new place: nothing of it cut yet, whatever depth the last one went to.
    if (fresh) prevZ = stockTop;
    const top0 = Math.min(above, prevZ);
    const done: Ring[] = [...(before ?? [])];
    for (const ring of rings) {
      const c = ring.thin ? gentle(ring.outside ? side : cut, ring.thin) : ring.outside ? side : cut;
      // The spindle speed of this ring's cut (a gentle one runs faster).
      if (c.s !== rpm) lines.push(`S${(rpm = c.s)}`);
      // Ground a smaller mill takes above this level later is still there under this ring: from its top.
      const top = Math.min(Math.max(top0, upTo?.(ring, z) ?? -Infinity), ring.from ?? Infinity);
      // Run from above its own level: the ring as cut and where from.
      if (top > above + 1e-6) raised?.(ring, z, top);
      const n = Math.max(1, Math.ceil((top - z) / c.ap - 1e-6));
      const passes = Array.from({ length: n }, (_, i) => top - ((top - z) * (i + 1)) / n);
      // Finishing looks through all the roughing's rings at this level (its rings lie next to them).
      const entry = done.length ? sideEntry(ring, finish ? done : done.slice(-4), r, c.ae, keep) : null;
      done.push(ring);
      if (entry) {
        // Start the ring where it is entered (an open piece from its nearer end).
        const pts = ring.closed ? [...ring.pts.slice(entry.at), ...ring.pts.slice(0, entry.at)] : entry.at ? [...ring.pts].reverse() : ring.pts;
        const q = pts[0];
        let fset = false;
        const feed = () => (fset ? '' : ((fset = true), ` F${c.f}.`));
        let zNow = clear;
        passes.forEach((pz, pi) => {
          // Over the entry in the cut ring's path, first and after an open piece (lifted and over by
          // rapid as the shop does, never back over the cut at feed).
          if (!pi || !ring.closed) lines.push(`G00 Z${n3((zNow = clear))}`, `G00 ${xy(entry.from)}`);
          // Down in that path (its disc is cut to the level's bottom) by rapid, the last mm at the entry
          // feed, across into this ring, round.
          if (zNow - pz > 1 + 1e-6) lines.push(`G00 Z${n3(pz + 1)}`);
          lines.push(`G01 Z${n3(pz)} F${c.fz}.`, `G01 ${xy(q)}`);
          fset = false;
          for (const p of pts.slice(1)) lines.push(`G01 ${xy(p)}${feed()}`);
          zNow = pz;
          // A closed ring: back across to the entry for its next pass.
          if (ring.closed && pi < passes.length - 1) lines.push(`G01 ${xy(q)}`, `G01 ${xy(entry.from)} F${c.fz}.`);
          else if (ring.closed) lines.push(`G01 ${xy(q)}`);
        });
        continue;
      }
      const pts = ring.pts;
      const m = pts.length;
      const tiny = m < 2 || perimeter(ring) < 1;
      // The owner's hole rule: a ring that is a circle smaller than the tool is written as arcs, a helix one G02/G03 a
      // turn down (never steeper than the ramp) and one full circle a level, not hundreds of tiny G01 chords.
      const circ = helix && ring.closed ? microCircle(pts, tool.diameter / 2) : null;
      const arc = (to: P2, z?: number) => `${circ!.ccw ? 'G03' : 'G02'} ${xy(to)}${z === undefined ? '' : ` Z${n3(z)}`} I${n3(circ!.c[0] - to[0])} J${n3(circ!.c[1] - to[1])}`;
      let at: P2 = pts[0];
      // Vertex index the closed ring continues from (the ramp ends between two of them).
      let k0 = 0;
      let zAt = top;
      lines.push(`G00 Z${n3(clear)}`, `G00 ${xy(at)}`, `G00 Z${n3(Math.max(top, prevZ) + 1)}`);
      passes.forEach((pz, pi) => {
        const from = pi ? passes[pi - 1] : top;
        const enter = pi === 0 || !ring.closed;
        if (enter && pi > 0) lines.push(`G00 Z${n3(clear)}`, `G00 ${xy(pts[0])}`, `G00 Z${n3(from + 1)}`);
        if (enter) {
          at = pts[0];
          k0 = 0;
          zAt = from;
          // Down to the material's top here (cleared above it) at the entry feed.
          lines.push(`G01 Z${n3(from)} F${c.fz}.`);
        }
        // Its whole circle in the air (or no ring to ramp along): straight down. A plunging material: straight down
        // plungeMm into it at most, the rest ramped.
        const z0 = tiny || (enter && inAir(pts[0], pz, from)) ? pz : straight ? Math.max(pz, (ring.closed ? zAt : from) - plungeMm(mat)) : null;
        if (z0 !== null) lines.push(`G01 Z${n3(z0)} F${c.fz}.`);
        const zs = z0 ?? (ring.closed ? zAt : from);
        if (zs > pz + 1e-6) {
          if (circ) {
            const turns = Math.max(1, Math.ceil((zs - pz) / slope / (2 * Math.PI * circ.r) - 1e-9));
            for (let t = 1; t <= turns; t++) lines.push(`${arc(at, zs - ((zs - pz) * t) / turns)}${t === 1 ? ` F${c.fz}.` : ''}`);
          } else if (ring.closed) {
            const start = k0;
            const rp = ramp(at, (k) => pts[(start + 1 + k) % m], zs, pz, slope);
            rp.pts.forEach((p, i) => lines.push(`G01 ${xyz(p)}${i ? '' : ` F${c.fz}.`}`));
            at = rp.end;
            k0 = (start + rp.k) % m;
          } else zigzag(pts, zs, pz, slope).forEach((p, i) => lines.push(`G01 ${xyz(p)}${i ? '' : ` F${c.fz}.`}`));
        }
        zAt = pz;
        // The ring at this depth, from where the tool is back to it.
        let fset = false;
        const feed = () => (fset ? '' : ((fset = true), ` F${c.f}.`));
        if (circ) lines.push(`${arc(at)}${feed()}`);
        else if (ring.closed) {
          for (let i = 1; i <= m; i++) lines.push(`G01 ${xy(pts[(k0 + i) % m])}${feed()}`);
          if (dist2(pts[k0 % m], at) > 1e-6) lines.push(`G01 ${xy(at)}`);
        } else for (const p of pts.slice(1)) lines.push(`G01 ${xy(p)}${feed()}`);
      });
    }
    prevZ = z;
  }
  lines.push(`G00 Z${n3(clear)}`);
  return { kind: finish ? 'finish' : 'pocket', purpose, name: `${finish ? 'SCHLICHTEN' : 'FRAESEN'}_${mm(tool.diameter)}MM`, tool, cut, lines };
}

/**
 * Of the chamfer triangles (their index in P, 9 numbers each), the ones a graver's paths ran along: their middle
 * within `reach` of a path seen from the top. Where a path was cut short (the jaws, the part in the way) the
 * chamfer is not taken for cut: a later clamping may still cut it.
 */
export function cutTris(P: ArrayLike<number>, tris: number[], paths: { pts: P2[] }[], reach: number): number[] {
  const near = (p: P2, a: P2, b: P2) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= reach;
  };
  return tris.filter((k) => {
    const m: P2 = [(P[k * 9] + P[k * 9 + 3] + P[k * 9 + 6]) / 3, (P[k * 9 + 1] + P[k * 9 + 4] + P[k * 9 + 7]) / 3];
    return paths.some(({ pts }) => pts.some((q, i) => (i ? near(m, pts[i - 1], q) : pts.length === 1 && near(m, q, q))));
  });
}

/**
 * The 90° graver's paths for 45° chamfers (setup frame, heights lo..hi): its tip E under the
 * chamfer and E off the wall below it, so its cone lies on the chamfer. Only along the edges
 * that have one, and only where the cone and the shank touch nothing else of the part. Below
 * the jaw limit only inside the part's outline (the stock and jaws are outside there).
 */
function chamferPaths(P: Float32Array, bands: { lo: number; hi: number }[], R: number, jawLimit: number): { z: number; pts: P2[]; top: number }[] {
  const E = 0.3;
  const out: { z: number; pts: P2[]; top: number }[] = [];
  for (const { lo, hi } of bands) {
    const t = lo - E;
    if (hi - t > R) continue; // wider than the graver's cone
    const wall = slice(P, lo - 0.02);
    const band = difference(wall, slice(P, (lo + hi) / 2));
    if (area(band) < 0.05) continue;
    // Where the tool touches more than its chamfer: at each height its cone (or shank) Ø.
    let hit: Region = [];
    for (let z = t + 0.25; z < Math.max(0, hi) + 0.25; z += 0.25) hit = union(hit, offset(slice(P, z), Math.min(R, z - t) - 0.05));
    let where = difference(offset(band, E + 0.3), hit);
    if (t < jawLimit) where = intersection(where, filled(wall));
    const loops = offset(wall, E).map((l) => [...l].reverse());
    for (const pts of trim(loops, where)) if (pts.length > 1) out.push({ z: t, pts, top: hi });
  }
  return out;
}

function chamfering(tool: CamTool, paths: { z: number; pts: P2[]; top: number }[], mat: string, limits: Limits, clear: number): CamOp {
  const cut = cutData(tool, 'chamfer', mat, limits);
  const lines = [`G00 G90 X${n3(paths[0].pts[0][0])} Y${n3(paths[0].pts[0][1])} S${cut.s} M03`];
  for (const { z, pts, top } of paths) {
    // Down over the chamfer's top (clear of the corner it is about to take off), then in.
    lines.push(`G00 Z${n3(clear)}`, `G00 X${n3(pts[0][0])} Y${n3(pts[0][1])}`, `G00 Z${n3(top + 1)}`, `G01 Z${n3(z)} F${cut.fz}.`);
    pts.slice(1).forEach((p, i) => lines.push(`G01 X${n3(p[0])} Y${n3(p[1])}${i ? '' : ` F${cut.f}.`}`));
  }
  lines.push(`G00 Z${n3(clear)}`);
  return { kind: 'chamfer', purpose: 'chamfer', name: 'FASE', tool, cut, lines };
}

/** The outline of a region (min and max X, Y). */
function extent(r: Region): { lo: P2; hi: P2 } | null {
  const pts = r.flat();
  if (!pts.length) return null;
  return { lo: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], hi: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] };
}

/**
 * The faces a later clamping could rest on the jaw tops by (you: "the part's base rests on top of the 45 mm jaws and the
 * part is gripped below it"), as depths under Z0: a face of the part looking down, 3 to 43 mm over the stock's bottom
 * (its body never reaches the table) and 0.5 mm or more under Z0 (the jaw tops' rule), with what stands just over it
 * wider than the body under it by 1 mm or more on both held sides, and that body's held faces the same from its bottom up.
 */
function ledgesOf(P: Float32Array, left: Left, sb: { lo: Vec; hi: Vec }): number[] {
  const zs = new Set<number>();
  for (let i = 0; i < P.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = P.subarray(i, i + 9);
    if (Math.abs(az - bz) > 1e-4 || Math.abs(az - cz) > 1e-4 || (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= -1e-9) continue;
    if (az > -0.5 + 1e-6 || az < sb.lo[2] + 3 - 1e-6 || az > sb.lo[2] + JAW - 2 + 1e-6) continue;
    zs.add(Math.round(az * 100) / 100);
  }
  const e3 = extent(left.at(sb.lo[2], sb.lo[2] + 3));
  if (!e3) return [];
  return [...zs]
    .filter((z) => {
      // Clear of the face by two of the simulation's cells: a slice nearer takes the other side's cells too.
      const gap = Math.max(0.6, 2 * left.skin);
      const below = extent(left.at(z - gap - 0.5, z - gap));
      const above = extent(left.at(z + gap, z + gap + 0.5));
      return !!below && !!above && Math.abs(below.lo[1] - e3.lo[1]) <= 0.2 && Math.abs(below.hi[1] - e3.hi[1]) <= 0.2 && above.lo[1] <= below.lo[1] - 1 && above.hi[1] >= below.hi[1] + 1;
    })
    .map((z) => Math.round(-z * 100) / 100)
    .sort((a, b) => a - b);
}

/**
 * On the parallels by the step whose underside is at z, the part's narrower body hanging between them: the parallels
 * that hold it so, or null. They stand under the Y faces of the band over the step, 0.3 mm in (as the reader puts them),
 * each wholly under the step; the body clear of them by 0.5 mm and 5 mm or more over the vise floor (a drill's point
 * past it); the jaws 3 mm or more up the band and 1.3 mm or more under Z0 (the face mill's and the graver's room).
 */
function stepFit(left: Left, sb: { lo: Vec; hi: Vec }, z: number, k: 0 | 1 = 1): { cale: number; grip: number } | null {
  const gap = Math.max(0.6, 2 * left.skin);
  const over = extent(left.at(z + gap, Math.min(z + gap + 3, -1.3)));
  const body = extent(left.at(sb.lo[2], z - gap));
  if (!over || !body) return null;
  // k: the axis across the jaws (Y as the part lies; X: as it would lie turned a quarter in the vise).
  const w = parallelWidth(over.hi[k] - over.lo[k]);
  // shortcut: 0.5 mm between the body and a parallel as wide as the reader draws it (the shop's own widths unknown).
  if (body.lo[k] < over.lo[k] + 0.3 + w + 0.5 || body.hi[k] > over.hi[k] - 0.3 - w - 0.5) return null;
  const strips = [over.lo[k] + 0.3, over.hi[k] - 0.3 - w].map((a) => (k === 1 ? rect(over.lo[0], a, over.hi[0], a + w) : rect(a, over.lo[1], a + w, over.hi[1])));
  // shortcut: 85 % of each parallel under the step bears it (holes and rounded ends of a flange over them); the shop's own figure unknown.
  if (!strips.every((st) => area(intersection(left.at(z, z + 0.3), st)) >= 0.85 * area(st))) return null;
  const cale = [...CALE_HEIGHTS].sort((p, q) => p - q).find((c) => z - c <= sb.lo[2] - 5 && JAW - c <= -1.3 - z && JAW - c >= GRIP_MIN);
  return cale === undefined ? null : { cale, grip: JAW - cale };
}

/**
 * Where the vise really touches what is left of the part (3-2-1): both jaws over the grip, the
 * parallels under it, the stop at its left. The jaws close on the widest material between the
 * part's bottom and their top; vise 1 holds it from the stop for 125 mm (jawsFrom), vise 2 from 175 to 300.
 */
function contactOf(left: Left, bottom: number, grip: number, twoVises: boolean, spacerX = 0, onJaw = false): { contact: Contact; width: number } {
  // On the jaw tops the band ends clear of the face resting on them (the simulation's cells there are the wider part's).
  const gap = Math.max(0.6, 2 * left.skin);
  const band = left.at(bottom, bottom + grip - (onJaw ? gap : 0));
  const e = extent(band);
  if (!e) return { contact: { jaws: 0, rest: [0, 0], stop: false }, width: 0 };
  // As thick as the simulation's grid steps: a flat face on the grid is a staircase that fine.
  const strip = Math.max(0.3, left.skin);
  // The vise and its parallels start at the stop: past a spacer there (Beta 2), that much left of the part.
  const x0 = e.lo[0] - spacerX;
  const spans = (len: number): [number, number][] => [[x0, x0 + len], ...(twoVises ? [[x0 + VISE.width + VISE.gap, x0 + VISE.width + VISE.gap + len] as [number, number]] : [])];
  const along = (r: Region, y0: number, y1: number, len: number) => spans(len).reduce((t, [a, b]) => t + area(intersection(r, rect(a, y0, b, y1))) / (y1 - y0), 0);
  const jaws = Math.min(along(band, e.lo[1], e.lo[1] + strip, VISE.width), along(band, e.hi[1] - strip, e.hi[1], VISE.width));
  const width = e.hi[1] - e.lo[1];
  const w = Math.min(6, width / 6);
  const floor = left.at(bottom, bottom + strip);
  // On the jaw tops: what lies on each (20 mm deep) beside the body they grip, just over their tops.
  const over = onJaw ? left.at(bottom + grip + gap, bottom + grip + gap + strip) : [];
  const eo = onJaw ? extent(over) : null;
  const rest: [number, number] = onJaw
    ? eo && eo.lo[1] < e.lo[1] - 0.5 && eo.hi[1] > e.hi[1] + 0.5
      ? [along(over, Math.max(eo.lo[1], e.lo[1] - JAW_DEPTH), e.lo[1], VISE.width), along(over, e.hi[1], Math.min(eo.hi[1], e.hi[1] + JAW_DEPTH), VISE.width)]
      : [0, 0]
    : [along(floor, e.lo[1], e.lo[1] + w, PARALLEL_LENGTH), along(floor, e.hi[1] - w, e.hi[1], PARALLEL_LENGTH)];
  // The part's own face against the stop (or the spacer there).
  const stop = area(intersection(band, rect(e.lo[0], e.lo[1], e.lo[0] + strip, e.hi[1]))) > 0.01;
  return { contact: { jaws, rest, stop }, width };
}

/** What an operation pushes the part with (physics.ts), and how far from its left face it works. */
function loadOf(op: CamOp, mat: string, left: number, width: number, limits: Limits): OpLoad {
  const { kc } = materialData(mat);
  const d = op.tool.diameter;
  const c = op.cut;
  let reach = 0;
  for (const l of op.lines) {
    if (l.startsWith('G00')) continue;
    const x = /X(-?[\d.]+)/.exec(l);
    if (x) reach = Math.max(reach, Number(x[1]) + d / 2 - left);
  }
  if (op.kind === 'drill' || op.kind === 'centre') return { side: 0, down: drillThrust(kc, d, c.fz, c.s), reach };
  const ae = op.kind === 'face' ? Math.min(d, width) : op.kind === 'pocket' ? d : c.ae;
  let side = PEAK * millForce(kc, c.ap, ae, c.f, c.s, d);
  // A milling op also runs round the outside with the contour's depth.
  if (op.kind === 'pocket') {
    const o = cutData(op.tool, 'contour', mat, limits);
    side = Math.max(side, PEAK * millForce(kc, o.ap, o.ae, o.f, o.s, d));
  }
  // Down: the helix pulls and pushes about half the side force; the mills ramp in (milling()).
  // shortcut: the same at 5° and 15° (the steeper ramp's end-tooth load is not modelled); model it if a part ever slips on an entry.
  // shortcut: a ring no longer than 1 mm is plunged like a drill and not counted here; rare (a hole the tool's size).
  return { side, down: side / 2, reach };
}

/** The operation at a share of its feed (the vise or the part cannot take more). */
function slowed(op: CamOp, k: number): CamOp {
  if (k >= 0.999) return op;
  const r = (v: number) => Math.max(1, Math.round((v * k) / 10) * 10);
  return { ...op, cut: { ...op.cut, f: r(op.cut.f), fz: r(op.cut.fz) }, lines: op.lines.map((l) => l.replace(/F(\d+(?:\.\d*)?)/g, (_, v: string) => `F${r(Number(v))}.`)) };
}

/**
 * The 90° graver along a top plate's lettering. With its tip h down, its cone is h wide each side
 * at the face: it runs h inside each groove's edge, then rings further in until the groove is
 * filled; strokes too thin for that are run again at half the depth.
 */
function engraving(tool: CamTool, grooves: { depth: number; region: Region }[], mat: string, limits: Limits, clear: number): CamOp | null {
  const cut = cutData(tool, 'engrave', mat, limits);
  const passes: { z: number; loop: P2[] }[] = [];
  for (const { depth, region } of grooves)
    for (const h of [depth, depth / 2]) {
      // What the deeper pass already covers is not run again.
      const covered = passes.length ? swept(passes.filter((p) => p.z === -depth).map((p) => ({ pts: p.loop, closed: true, outside: false })), depth) : [];
      let rest = h === depth ? region : difference(region, covered);
      for (let k = 0; k < 20 && area(rest) > 0.005; k++) {
        const loops = offset(rest, -h).filter((l) => l.length > 2);
        if (!loops.length) break;
        for (const loop of loops) passes.push({ z: -h, loop });
        rest = offset(rest, -1.6 * h);
      }
    }
  if (!passes.length) return null;
  const lines = [`G00 G90 X${n3(passes[0].loop[0][0])} Y${n3(passes[0].loop[0][1])} S${cut.s} M03`];
  for (const { z, loop } of passes) {
    lines.push(`G00 Z${n3(clear)}`, `G00 X${n3(loop[0][0])} Y${n3(loop[0][1])}`, 'G00 Z1.', `G01 Z${n3(z)} F${cut.fz}.`);
    [...loop.slice(1), loop[0]].forEach((p, i) => lines.push(`G01 X${n3(p[0])} Y${n3(p[1])}${i ? '' : ` F${cut.f}.`}`));
  }
  lines.push(`G00 Z${n3(clear)}`);
  return { kind: 'chamfer', purpose: 'engrave', name: 'GRAVIEREN', tool, cut, lines };
}

/** How the program does once read back and simulated like the toolpath viewer does it. */
export interface CamCheck {
  /** How alike the simulated part and the model are (0..1), and where they differ. */
  match: number;
  pieces: Piece[];
  minutes: number;
  toolChanges: number;
  /** Tools or holders into the jaws or the part, rapids into material (all block it). */
  collisions: number;
  /** Of those: the shop's holder (Ø50 then Ø63 from the typed length) into material, rapids through material, tools or holders into the stop below the jaw tops. */
  holders: number;
  rapids: number;
  stops: number;
  /** The rapids (code lines) that only graze a sliver: run at feed by camProgram. */
  grazes: number[];
  /** Spots where a tool goes into a cale under the part (move that cale: a warning). */
  cales: number;
  /**
   * Clampings where the faces the vise holds (between the parallels and the jaw tops) lie more than
   * MISPLACED mm from where the program puts the part at the stop or the fixed jaw: on the machine the
   * part would sit that far off, which the simulation (it places the part by the size written) cannot
   * show. Blocks the program, like a collision.
   */
  misplaced: number;
  /**
   * The simulated part has the model's size (each axis within 1.5 mm or 5 %, the toolpath viewer's own test): false when
   * stock stands out of it (stubs left where two clampings' cuts meet). Blocks the program, as the viewer then says it is not this part.
   */
  sized: boolean;
}

/** How far the held faces may lie from where the program puts them (mm): the simulation's grid. */
const MISPLACED = 0.5;
/**
 * The operator's minutes for one clamping (open the vise, turn the part, parallels, stop, close).
 * shortcut: an assumption, not measured at the shop; the shop's own figure replaces it.
 */
const CLAMPING_MIN = 2;
/** Plans whose times differ by no more than this are a tie, which the fewer clampings win (minutes). */
const TIE_MIN = 1;

/**
 * Plan p takes less time than q: the machine's minutes and the operator's for each clamping (turning the part
 * over, the parallels, the stop), so a clamping more must save more than that; within TIE_MIN of each other,
 * the fewer clampings win (you: fewer setups).
 */
export function cheaper(p: { minutes: number; clampings: number }, q: { minutes: number; clampings: number }): boolean {
  const [cp, cq] = [p.minutes + CLAMPING_MIN * p.clampings, q.minutes + CLAMPING_MIN * q.clampings];
  return p.clampings !== q.clampings && Math.abs(cp - cq) <= TIE_MIN ? p.clampings < q.clampings : cp < cq;
}

/** Samples of the finer last look at the tools' cuts into the part (the check's 300,000 see none under about 2 mm). */
const FINE_VOXELS = 2_000_000;

/**
 * Where the tools take material the model keeps, on a grid about 7 times finer than the check's: a difference counts
 * only 3 samples thick, so the check misses a cut under about 2 mm (the study's E1). Only cuts into the part: the
 * inside corners left at a mill's radius (the shop's way) would read as material left on this grid.
 */
export function fineCuts(tris: ArrayLike<number>, code: string, brand?: string, speeds?: MachineSpeeds, pose?: CamResult['pose']): Piece[] {
  const tp = parseToolpath(code, speeds ?? speedsFor(brand));
  const sim = buildInput(tp, analyseProgram(tp, { jawHeight: JAW }));
  if (!sim || !pose) return [];
  const g = carve({ ...sim, maxVoxels: FINE_VOXELS, surfaceMoves: false });
  return differences({ g, occ: voxelize(tris, pose.R, pose.t, g) }).pieces.filter((p) => p.kind === 'cut');
}

/** How far a clamping keeps off a face a later one finishes whole (more than the simulation's grid, so it sees the skin). */
export const RESERVE = 1;

/**
 * You: a face finished in two clampings shows a step where they meet (a turn is never exact). Of the program's faces
 * (coplanar model triangles), those two clampings or more finish (the clamping whose cut reaches furthest over the
 * stock just outside each sample, every ~0.5 mm, as the toolpath viewer cuts it; the second at least 10 % of the face
 * and 2 mm²), and for each one the last of them reaches whole (nothing of the part between the face and that
 * clamping's spindle, 95 % of its samples), the faces the earlier ones (not the first) are to keep off: 50 mm² or more.
 */
export function oneClamping(tris: ArrayLike<number>, code: string, brand: string | undefined, speeds: MachineSpeeds | undefined, pose: NonNullable<CamResult['pose']>, sides: string[]): { reserve: { side: string; tris: number[] }[]; splitMm2: number; uncutMm2: number } {
  const tp = parseToolpath(code, speeds ?? speedsFor(brand));
  const an = analyseProgram(tp, { jawHeight: JAW });
  const sim = buildInput(tp, an);
  if (!sim) return { reserve: [], splitMm2: 0, uncutMm2: 0 };
  const g = carve({ ...sim, maxVoxels: 600_000 });
  const occ = voxelize(tris, pose.R, pose.t, g);
  const [nx, ny, nz] = g.n;
  const at = (q: Vec) => {
    const i = [0, 1, 2].map((k) => Math.round((q[k] - g.origin[k]) / g.step[k]));
    return i[0] < 0 || i[1] < 0 || i[2] < 0 || i[0] >= nx || i[1] >= ny || i[2] >= nz ? -1 : (i[2] * ny + i[1]) * nx + i[0];
  };
  const toPart = (p: Vec): Vec => apply(pose.R, p).map((v, k) => v + pose.t[k]) as Vec;
  // Each clamping's spindle axis in the part's frame (machine = orient · part + offset).
  const up = an.setups.map((x) => [x.orient[6], x.orient[7], x.orient[8]] as Vec);
  const open = (q: Vec, u: Vec) => {
    for (let s = g.size; s < 400; s += g.size / 2) {
      const v = at([q[0] + u[0] * s, q[1] + u[1] * s, q[2] + u[2] * s]);
      if (v < 0) return true;
      if (occ[v]) return false;
    }
    return true;
  };
  // Per face also its samples where stock is still there just outside it (a skin a reserved face can be left with).
  const faces = new Map<string, { tris: number[]; area: number; samples: { q: Vec; n: Vec; by: number }[]; uncut: number; all: number }>();
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = [tris[i], tris[i + 1], tris[i + 2]];
    const u = [tris[i + 3] - a[0], tris[i + 4] - a[1], tris[i + 5] - a[2]];
    const w = [tris[i + 6] - a[0], tris[i + 7] - a[1], tris[i + 8] - a[2]];
    const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(x[0], x[1], x[2]);
    if (len < 1e-9) continue;
    const n = x.map((v) => v / len) as Vec;
    const key = `${n.map((v) => Math.round(v * 50)).join(',')}:${Math.round((n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * 20)}`;
    const f = faces.get(key) ?? faces.set(key, { tris: [], area: 0, samples: [], uncut: 0, all: 0 }).get(key)!;
    f.tris.push(i / 9);
    f.area += len / 2;
    const np = apply(pose.R, n) as Vec;
    const steps = Math.min(60, Math.max(2, Math.ceil(Math.sqrt(len / 2) / 0.5)));
    for (let s = 0; s < steps; s++)
      for (let t = 0; t < steps - s; t++) {
        const [p1, p2] = [(s + 0.33) / steps, (t + 0.33) / steps];
        const q = toPart([0, 1, 2].map((k) => a[k] + u[k] * p1 + w[k] * p2) as Vec).map((v, k) => v + np[k] * 0.7 * g.size) as Vec;
        const v = at(q);
        if (v < 0 || occ[v]) continue;
        f.all++;
        if (g.removed[v] === KEPT) {
          f.uncut++;
          continue;
        }
        const m = g.outer?.get(v) ?? g.removed[v];
        if (sim.moves[m]) f.samples.push({ q, n: np, by: sim.moves[m].setup });
      }
  }
  const reserve = new Map<string, number[]>();
  let splitMm2 = 0;
  let uncutMm2 = 0;
  for (const f of faces.values()) {
    if (f.all) uncutMm2 += (f.area * f.uncut) / f.all;
    const count = new Map<number, number>();
    for (const x of f.samples) count.set(x.by, (count.get(x.by) ?? 0) + 1);
    const by = [...count].sort((p, q) => q[1] - p[1]);
    if (f.samples.length < 8 || by.length < 2 || by[1][1] < 0.1 * f.samples.length || (f.area * by[1][1]) / f.samples.length < 2) continue;
    splitMm2 += f.area;
    // Only the large faces (a pocket's walls and floor): keeping off a small or curved one leaves slivers only tiny mills
    // reach (the study's part: a Ø1 for 4,906 lines).
    if (f.area < 50) continue;
    const last = Math.max(...by.map(([s]) => s));
    const u = up[last];
    if (!u || sides[last] === undefined) continue;
    const reach = f.samples.filter((x) => x.n[0] * u[0] + x.n[1] * u[1] + x.n[2] * u[2] >= -0.05 && open(x.q, u)).length;
    if (reach < 0.95 * f.samples.length) continue;
    // Never in the first clamping (the outline and most of the part): its faces left to a later one made the study's
    // part 26.6 minutes long against 20.1 (the later clampings chasing them with small mills); in the later ones 20.5.
    for (const [s] of by) if (s > 0 && s < last && sides[s] !== undefined) reserve.set(sides[s], [...(reserve.get(sides[s]) ?? []), ...f.tris]);
  }
  return { reserve: [...reserve].map(([side, t]) => ({ side, tris: t })), splitMm2: Math.round(splitMm2), uncutMm2: Math.round(uncutMm2) };
}

export function checkProgram(tris: ArrayLike<number>, code: string, brand?: string, speeds?: MachineSpeeds, pose?: CamResult['pose'], corners?: Corner[]): CamCheck {
  const tp = parseToolpath(code, speeds ?? speedsFor(brand));
  const an = analyseProgram(tp, { jawHeight: JAW });
  const sim = buildInput(tp, an);
  // CAM AI's own program: the model where it was planned (a best fit could lay a nearly symmetric
  // part the wrong way round and hide or invent differences); anyone else's: the best fit.
  let diff: ReturnType<typeof differences> | null = null;
  let sized = false;
  if (sim && pose) {
    const base = { ...sim, maxVoxels: 300_000, surfaceMoves: false };
    const g = carve(base);
    sized = sizeFits(modelBox(tris), partExtent(base, g).map(([lo, hi]) => hi - lo) as Vec).length > 0;
    // A corner's region grown by a sample, where the two grids never quite agree.
    const e = Math.max(...g.step);
    const grown = corners?.map((c) => ({ ...c, region: offset(c.region, e) }));
    const accepted = grown?.length
      ? (p: Vec) =>
          grown.some((c) => {
            const q = apply(c.M, p).map((v, k) => v + c.b[k]);
            return q[2] > c.z - e && q[2] < c.above + e && inside(c.region, [q[0], q[1]]) !== 0;
          })
      : undefined;
    diff = differences({ g, occ: voxelize(tris, pose.R, pose.t, g) }, 2, accepted);
  } else if (sim) {
    const laid = layModel(tris, sim, an.setups);
    diff = 'mismatch' in laid ? null : differences(laid);
    sized = !('mismatch' in laid);
  }
  const hits = an.setups.flatMap((x) => x.collisions);
  const stops = an.setups.reduce((n, x) => n + stopHits(tp, x).length, 0);
  // Check 1, geometric, on every move against the stock as it is then: the shop's holder above the
  // typed length; and a rapid must not take any material (cut as if it were a feed: what it would
  // remove first is a crash).
  let holders = 0;
  let rapids = 0;
  const grazes: number[] = [];
  if (sim) {
    const g = carve({ ...sim, maxVoxels: 600_000, surfaceMoves: false });
    holders = holderHits(sim, g, tp.moves.map(movePath), tp.moves.map((m) => m.reach), tp.moves.map((m) => m.dia), shopHolder).length;
    const all = carve({ ...sim, moves: tp.moves.map((m) => ({ setup: m.setup, tool: m.tool, points: movePath(m) })), maxVoxels: 300_000, surfaceMoves: false, dropLoose: false });
    // Each rapid that takes material, with the grid columns (x, y) it takes it in.
    const into = new Map<number, Set<number>>();
    const plane = all.n[0] * all.n[1];
    for (let v = 0; v < all.removed.length; v++) {
      const i = all.removed[v];
      if (i !== KEPT && tp.moves[i]?.kind === 'rapid') (into.get(i) ?? into.set(i, new Set()).get(i)!).add(v % plane);
    }
    rapids = into.size;
    // Straight down, its edge only grazing a sliver (two grid columns at most): fine at feed. Not a
    // drilling cycle's way down to its R plane: its line has no G00 to slow down, it stays a collision.
    for (const [i, cols] of into) {
      const [a, b] = [tp.moves[i].points[0], tp.moves[i].points[tp.moves[i].points.length - 1]];
      const cycle = tp.moves[i + 1]?.kind === 'drill' && tp.moves[i + 1].line === tp.moves[i].line;
      if (!cycle && cols.size <= 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) grazes.push(tp.moves[i].line);
    }
  }
  return {
    match: diff?.match ?? 0,
    pieces: diff?.pieces ?? [],
    sized,
    minutes: tp.totalSeconds / 60,
    toolChanges: tp.toolChanges,
    // Unlike the remapper (a warning there), CAM AI's own program goes no more than CALE_TOUCH into a
    // parallel, never at rapid (shop rule): deeper through-cuts stop on them (overParallels); one still
    // going in blocks it.
    collisions: hits.filter((h) => h.what !== 'spacer').length + holders + rapids + stops,
    holders,
    rapids,
    stops,
    grazes,
    cales: hits.filter((h) => h.what === 'cale').length,
    misplaced: an.setups.filter((x) => x.grip && x.clampBox && Math.max(Math.abs(x.grip.stop - x.clampBox.min[0]), Math.abs(x.clampBox.max[1] - x.grip.back)) > MISPLACED).length,
  };
}

/**
 * The rapids down past stock the check's grid is too coarse to see (a rim through a thin skin left along a
 * wall: up to 0.1 mm, found at 2M voxels in Phase 6), on a finer grid: such a rapid stays a rapid down to
 * 1 mm above the highest stock it touches and feeds the rest, at the feed of the move after it. `rimOnly`:
 * only one that touches stock with its rim (half a mm, or a cell, in from its edge): deeper in, it stays a
 * rapid into material, which the check counts.
 */
export function finerRapids(code: string, brand?: string, speeds?: MachineSpeeds, voxels = 2_000_000, rimOnly = false): string {
  const tp = parseToolpath(code, speeds ?? speedsFor(brand));
  const sim = buildInput(tp, analyseProgram(tp, { jawHeight: JAW }));
  if (!sim) return code;
  const g = carve({ ...sim, moves: tp.moves.map((m) => ({ setup: m.setup, tool: m.tool, points: movePath(m) })), maxVoxels: voxels, surfaceMoves: false, dropLoose: false });
  // The highest stock each straight rapid down takes, in its program's Z (and the lines one takes deeper in than its rim).
  const plane = g.n[0] * g.n[1];
  const hit = new Map<number, number>();
  const deep = new Set<number>();
  for (let v = 0; v < g.removed.length; v++) {
    const i = g.removed[v];
    const m = i === KEPT ? undefined : tp.moves[i];
    if (m?.kind !== 'rapid') continue;
    const [a, b] = [m.points[0], m.points[m.points.length - 1]];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6 || b[2] >= a[2]) continue;
    const { orient: R, offset: t } = sim.setups[m.setup];
    const p = [g.origin[0] + ((v % g.n[0]) + 0.5) * g.step[0], g.origin[1] + ((Math.floor(v / g.n[0]) % g.n[1]) + 0.5) * g.step[1], g.origin[2] + (Math.floor(v / plane) + 0.5) * g.step[2]];
    const path = movePath(m);
    // Up to a cell above the highest sample it takes: the stock reaches no higher.
    const z = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2] - (path[path.length - 1][2] - b[2]) + g.step[2];
    hit.set(m.line, Math.max(hit.get(m.line) ?? -Infinity, z));
    const off = Math.hypot(R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0] - path[0][0], R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1] - path[0][1]);
    if (rimOnly && !(off >= (m.dia ?? 0) / 2 - Math.max(0.5, g.size))) deep.add(m.line);
  }
  for (const l of deep) hit.delete(l);
  if (!hit.size) return code;
  const lines = code.split('\n');
  const from = new Map(tp.moves.filter((m) => m.kind === 'rapid').map((m) => [m.line, m.points[0][2]]));
  const feedOf = (l: string) => l.replace(/\([^)]*\)/g, '').match(/(?<![A-Z])F(\d+\.?\d*)/)?.[1];
  const out: string[] = [];
  // The feed in force (the moves after the rest keep it).
  let feed: string | undefined;
  lines.forEach((l, i) => {
    const z = hit.get(i);
    const down = z === undefined ? null : l.match(/^N\d+ G0?0 Z(-?[\d.]+)$/);
    const z0 = from.get(i);
    if (z === undefined || !down || z0 === undefined) {
      out.push(l);
      feed = feedOf(l) ?? feed;
      return;
    }
    // At the feed the next move writes, else the one in force (a review finding: not the next one further on).
    const f = Number(feedOf(lines[i + 1] ?? '') ?? feed ?? feedOf(lines.slice(i + 1, i + 6).join(' ')) ?? 300);
    const stop = Math.round((z + 1) * 1000) / 1000;
    if (stop < z0 - 1e-3) out.push(`N0 G00 Z${n3(stop)}`);
    out.push(`N0 G01 Z${down[1]} F${n3(f)}`);
  });
  let n = 0;
  return out.map((l) => (/^N\d+ /.test(l) ? `N${++n} ${l.replace(/^N\d+ /, '')}` : l)).join('\n');
}

/**
 * The program checked. A rapid down whose edge only grazes a sliver the rings left (the tool's
 * own path misses it by less than a grid cell) runs at the feed of the move after it; checked again.
 * Any other rapid into material stays a collision (it blocks the program).
 */
/**
 * A made program with operations changed by hand (you, Beta 2: items 10 and 11), by operation key: the plan kept, those
 * operations' lines moved or taken deeper (opEdit.ts), the vise check of their clampings done again with the new cuts,
 * the program posted and checked again whole (later cuts and holders depend on what an edited one removed).
 */
/** The operator's turn of clamping k (CamInput.frames), when it is one of the 24 turns of the part. */
function frameAt(input: CamInput, k: number): Mat3 | undefined {
  const f = k >= 0 ? input.frames?.[k] : undefined;
  return f && f.length === 9 && ALL.some((R) => R.every((v, i) => v === f[i])) ? (f.slice() as Mat3) : undefined;
}

/** Milling made for what the mills before it left: their order is the plan's own (a rest or finish mill first would cut full stock). */
const MILLING: Purpose[] = ['outline', 'rough', 'rest', 'finish', 'contour', 'thinWalls', 'chamfer', 'engrave'];

/**
 * A clamping's operations in the operator's order (you: tools dragged in the list), `want` their keys: those listed run
 * in that order in the places they hold, the others stay where they were made. By key, never by tool: a tool changed by
 * hand keeps its place, and a tool used in two places is not pulled together when another one is moved. What runs before
 * an operation it was made after (the facing before all, a spot drill before the drills, the mills in their made order,
 * a mill before a drill whose holes it goes into) is not verified by any check: that one is marked unsafe (the program
 * locks) and noted.
 */
export function reorderOps(ops: CamOp[], want: string[] | undefined, setup: number): { ops: CamOp[]; notes: CamNote[] } {
  const rank = (o: CamOp) => (o.key === undefined ? -1 : (want?.indexOf(o.key) ?? -1));
  if (!want?.length || !ops.some((o) => rank(o) >= 0)) return { ops, notes: [] };
  const listed = ops.filter((o) => rank(o) >= 0).sort((a, b) => rank(a) - rank(b));
  let j = 0;
  const out = ops.map((o) => (rank(o) >= 0 ? listed[j++] : o));
  const made = new Map(ops.map((o, i) => [o, i]));
  // A mill made after a drill that feeds inside one of its holes under Z0 (a counterbore's seat, a pocket's entry down
  // the hole) cuts air there only once the hole is drilled: never before it.
  const holes = new Map<CamOp, P2[]>();
  const holesOf = (op: CamOp) => {
    let out = holes.get(op);
    if (!out) {
      out = [];
      let [x, y, cycle] = [NaN, NaN, false];
      for (const l of op.lines) {
        if (l.startsWith('(')) continue;
        x = Number(l.match(/X(-?[\d.]+)/)?.[1] ?? x);
        y = Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? y);
        if (/G8[1-3]|G73/.test(l)) {
          cycle = true;
          out.push([x, y]);
        } else if (/G80/.test(l)) cycle = false;
        else if (cycle && /[XY]-?[\d.]/.test(l)) out.push([x, y]);
      }
      holes.set(op, out);
    }
    return out;
  };
  const entersHoles = (mill: CamOp, drill: CamOp) => {
    const at = holesOf(drill);
    const r = drill.tool.diameter / 2;
    let [x, y, z, g] = [NaN, NaN, NaN, 0];
    for (const l of mill.lines) {
      g = Number(l.match(/\bG0?([0-3])\b/)?.[1] ?? g);
      x = Number(l.match(/X(-?[\d.]+)/)?.[1] ?? x);
      y = Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? y);
      z = Number(l.match(/Z(-?[\d.]+)/)?.[1] ?? z);
      if (g >= 1 && z < -0.05 && at.some(([hx, hy]) => Math.hypot(x - hx, y - hy) < r)) return true;
    }
    return false;
  };
  const mustFollow = (a: CamOp, b: CamOp) =>
    a.purpose === 'face' ||
    (a.purpose === 'centre' && (b.purpose === 'drill' || b.purpose === 'pinHoles')) ||
    (MILLING.includes(a.purpose) && MILLING.includes(b.purpose)) ||
    ((a.purpose === 'drill' || a.purpose === 'pinHoles') && MILLING.includes(b.purpose) && entersHoles(b, a));
  const notes: CamNote[] = [];
  const ordered = out.map((b, i) => {
    // The first one made before b, and made for b to follow it, that now runs after it.
    const a = out.slice(i + 1).find((x) => made.get(x)! < made.get(b)! && mustFollow(x, b));
    if (!a) return b;
    if (!notes.some((n) => n.used === b.tool.number)) notes.push({ key: 'orderLocked', setup, used: b.tool.number, d: a.tool.number });
    return { ...b, cut: { ...b.cut, unsafe: true } };
  });
  return { ops: ordered, notes };
}

export function editProgram(input: CamInput, r: CamResult, edits: Record<string, OpEdit>, order?: Record<string, string[]>): CamResult & { check: CamCheck } {
  // A tool changed by hand gets a T number nothing else in the program uses (from 99 down) and a code no inventory has
  // (the shop's pattern, so the remapper reads its type, Ø and length, ending "_HAND"): only the remapper gives it a
  // machine tool, never Download by mistake.
  // Nor any number the machine has: the operator would load the tool sitting there.
  const used = new Set([...r.setups.flatMap((s) => s.ops.map((o) => o.tool.number)), ...input.tools.map((t) => t.number)]);
  const free = () => {
    let n = 99;
    while (used.has(n)) n--;
    used.add(n);
    return n;
  };
  const maxRpm = input.limits?.maxRpm ?? DEFAULT_LIMITS.maxRpm;
  // A tool of the shop picked by its code: in the machine or the tool database, else refused.
  const shelf = Object.values(edits).some((e) => e.tool?.code) ? catalog(input.material, input.tools, { toolDb: input.toolDb }) : [];
  const shopTool = (code: string) => {
    const x = shelf.find((c) => c.code === code);
    if (!x) throw new Error('An edit by hand out of range.');
    return x;
  };
  // Only sizes a hand would type: anything else is refused, never planned.
  if (!Object.values(edits).every(editInRange)) throw new Error('An edit by hand out of range.');
  // An edited cut that reaches the vise floor is noted and locks the program (checked, below).
  const orderNotes: CamNote[] = [];
  const setups = r.setups.map((s, si) => {
    let touched = false;
    const edited = s.ops.flatMap((op, k): CamOp[] => {
      const e = edits[op.key ?? `${s.side}|${op.name}|${op.tool.code}|${k}`];
      if (!e) return [op];
      touched = true;
      // Deleted: out of the program (the post writes a tool change only for a tool with operations left).
      if (e.off) return [];
      const lines = editOpLines(op.lines, e);
      // Its last pass that much deeper: what the vise check loads it with.
      const moved = { ...op, lines, cut: { ...op.cut, ap: op.cut.ap + Math.max(0, e.deeper ?? 0) } };
      const pick = e.tool?.code ? shopTool(e.tool.code) : null;
      if (!e.tool || (pick ? pick.code === op.tool.code : e.tool.d === op.tool.diameter && e.tool.l === op.tool.length)) return [moved];
      const d = pick ? pick.diameter : e.tool.d;
      // The same surface speed as the tool it replaces, never over the machine's top rpm; the feed never over the made one.
      const k2 = Math.min(op.tool.diameter / d, maxRpm / Math.max(1, op.cut.s));
      const kf = Math.min(1, k2);
      const s2 = Math.max(100, Math.round((op.cut.s * k2) / 50) * 50);
      // The shop's tool keeps its own number in the machine; one from the database gets one nothing else in the program uses.
      const tool: CamTool = pick
        ? { ...pick, number: pick.inMachine ? pick.number : free() }
        : { ...op.tool, id: `hand-${e.tool.d}-${e.tool.l}`, number: free(), diameter: e.tool.d, length: e.tool.l, code: `${op.tool.type}_${e.tool.d.toFixed(2).padStart(5, '0')}_${String(Math.round(e.tool.l)).padStart(3, '0')}_000_HAND`, inMachine: false, template: null };
      // The made step-down and step-over on a smaller tool: more than its Ø is too much for it (the program locks).
      const unsafe = !!op.cut.unsafe || (op.kind !== 'drill' && op.kind !== 'centre' && (moved.cut.ap > d || op.cut.ae > d));
      return [{ ...moved, tool, lines: scaleSpeeds(lines, k2, kf), cut: { ...moved.cut, s: s2, f: Math.round(op.cut.f * kf), fz: Math.round(op.cut.fz * kf), unsafe } }];
    });
    // Then the operator's order (the edits above went by the made keys).
    const re = reorderOps(edited, order?.[s.side], si + 1);
    const ops = re.ops;
    orderNotes.push(...re.notes);
    touched ||= ops.some((o, i) => o !== s.ops[i]) || ops.length !== s.ops.length;
    if (!touched || !s.vise) return touched ? { ...s, ops } : s;
    const v = s.vise;
    const loads = ops.map((op) => loadOf(op, v.material, v.left, v.width, v.limits));
    const physics = v.screws !== undefined ? checkNest({ material: v.material, loads, screws: v.screws }) : checkSetup({ material: v.material, length: v.length, width: v.width, height: v.height, grip: v.grip, thin: v.thin, contact: v.contact!, loads, squeeze: v.squeeze });
    return { ...s, ops, physics };
  });
  return checked(input, { ...r, setups, notes: [...r.notes.filter((n) => n.key !== 'orderLocked'), ...orderNotes], code: post(input, setups, r.size, r.raw) });
}

/** The lowest Z an operation's lines go to (its own frame): its moves and drill cycles, not a machine position. */
const lowest = (lines: string[]) => Math.min(...lines.flatMap((l) => (/^\s*(T\d|M0|\()|G53|G28|G52|G43/.test(l) ? [] : [...l.split('(')[0].matchAll(/Z(-?\d*\.?\d*)/g)].map((m) => Number(m[1])))));

function checked(input: CamInput, r: CamResult): CamResult & { check: CamCheck } {
  // The simulation has no vise floor (docs/knowledge): a clamping with a cut within 0.5 mm of it is noted, and locks the program.
  const floorHits: CamNote[] = r.setups.flatMap((s, i) => (s.vise && s.ops.some((op) => lowest(op.lines) < s.vise!.floor + 0.5 - 1e-6) ? [{ key: 'floorHit' as const, setup: i + 1 }] : []));
  r = { ...r, notes: [...r.notes.filter((n) => n.key !== 'floorHit'), ...floorHits] };
  const again = (code: string) => checkProgram(input.tris, code, input.brand, input.speeds, r.pose, r.corners);
  let code = r.code;
  let check = again(code);
  if (check.rapids && check.grazes.length === check.rapids) {
    const lines = code.split('\n');
    for (const i of check.grazes) {
      const f = lines.slice(i + 1, i + 6).join(' ').match(/F(\d+)/)?.[1] ?? '300';
      lines[i] = `${lines[i].replace(/\bG00\b/, 'G01')} F${f}.`;
    }
    check = again((code = lines.join('\n')));
  }
  // A rapid down whose rim grazes stock (the check's own grid, its 300k voxels): fed the rest of the way from
  // 1 mm above it, and kept when nothing else is worse (the validation found one 0.2 mm in, from a floor's edge).
  if (check.rapids) {
    const fed = finerRapids(code, input.brand, input.speeds, 300_000, true);
    const c = fed === code ? check : again(fed);
    if (c.rapids < check.rapids && c.collisions < check.collisions && c.match >= check.match - 0.0005 && gougeOf(c) <= gougeOf(check)) [code, check] = [fed, c];
  }
  // Through-cuts over a parallel stop on it (the part's bottom rests there): checked again.
  if (check.cales) check = again((code = overParallels(code, input.speeds ?? speedsFor(input.brand))));
  return { ...r, code, check };
}

/**
 * Shop rule: no tool more than CALE_TOUCH into a parallel. When one goes deeper, every feed move over one (within the tool's radius, inside
 * the vise) and below its top is raised to its top, the part's bottom resting there: a through-cut
 * stops there, not 0.2 below. A move that runs onto or off one is split at the edge, going up or
 * down beside it. Moves only ever go higher. A drilled hole over one keeps its depth (its point
 * would still go in): it stays a collision.
 */
function overParallels(code: string, speeds: MachineSpeeds): string {
  const tp = parseToolpath(code, speeds);
  const an = analyseProgram(tp, { jawHeight: JAW });
  const lines = code.split('\n');
  const z3 = (p: number[], q: number[], t: number) => p.map((v, k) => v + (q[k] - v) * t);
  for (const s of an.setups) {
    if (!s.cales?.length || !s.moves || !s.clampBox) continue;
    const spans: [number, number][] = s.jawTopZ !== null ? viseSpans(s) : [[s.clampBox.min[0], s.clampBox.max[0]]];
    let at: number | null = null; // the height the tool is really at after the last rewritten move
    for (let mi = s.moves[0]; mi <= s.moves[1]; mi++) {
      const m = tp.moves[mi];
      if (m.setup !== s.index) continue;
      if (m.kind !== 'feed' || m.points.length !== 2) {
        at = null;
        continue;
      }
      const r = (m.dia ?? 0) / 2 + 0.05;
      const boxes = s.cales.flatMap((c) => spans.map(([a, b]) => ({ x: [a - r, b + r], y: [c.y[0] - r, c.y[1] + r], top: c.top })));
      const [p, q] = m.points;
      // Split where it crosses a box's edge or its top; each piece over a box below its top goes up to it.
      const ts = [0, 1];
      for (const bx of boxes) {
        for (const k of [0, 1] as const) for (const e of k ? bx.y : bx.x) if (q[k] !== p[k]) ts.push((e - p[k]) / (q[k] - p[k]));
        if (q[2] !== p[2]) ts.push((bx.top - p[2]) / (q[2] - p[2]));
      }
      const cuts = [...new Set(ts.filter((t) => t >= 0 && t <= 1).map((t) => Math.round(t * 1e9) / 1e9))].sort((u, v) => u - v);
      const lift = (t0: number, t1: number) => {
        const mid = z3(p, q, (t0 + t1) / 2);
        return Math.max(-Infinity, ...boxes.filter((bx) => mid[0] > bx.x[0] && mid[0] < bx.x[1] && mid[1] > bx.y[0] && mid[1] < bx.y[1] && mid[2] < bx.top - 1e-6).map((bx) => bx.top));
      };
      const pieces = cuts.slice(1).map((t1, i) => ({ t0: cuts[i], t1, top: lift(cuts[i], t1) }));
      if (pieces.every((pc) => pc.top === -Infinity)) {
        // Back to its own height (a line without a height of its own would stay up).
        if (at !== null && Math.abs(at - p[2]) > 1e-6 && !/Z-?[\d.]/.test(lines[m.line])) lines[m.line] += ` Z${n3(q[2])}`;
        at = null;
        continue;
      }
      const n = lines[m.line].match(/^N\d+\s*/)?.[0] ?? '';
      const f = lines[m.line].match(/F[\d.]+/)?.[0];
      const out: string[] = [];
      let z = at ?? p[2];
      for (const pc of pieces) {
        const [a, b] = [z3(p, q, pc.t0), z3(p, q, pc.t1)];
        const [za, zb] = [Math.max(a[2], pc.top), Math.max(b[2], pc.top)];
        if (Math.abs(za - z) > 1e-6) out.push(`G01 Z${n3(za)}`); // up or down beside the parallel
        out.push(`G01 X${n3(b[0])} Y${n3(b[1])} Z${n3(zb)}`);
        z = zb;
      }
      out[0] = `${n}${out[0]}${f ? ` ${f}` : ''}`;
      lines[m.line] = out.join('\n');
      at = z;
    }
  }
  return lines.join('\n');
}

/** All the pieces cut out of the part that the model keeps, added up (mm³): an overcut (four small ones are one bad part). */
export const gougeOf = (c: CamCheck) => Math.round(c.pieces.reduce((t, p) => t + (p.kind === 'cut' ? p.mm3 : 0), 0));

/**
 * The program for a part: planned with each of its sides as the height in the vise (thinnest
 * first), each checked like the toolpath viewer checks it, the right one (99 % like the model, no
 * collision, held safely) that takes the least time kept. `progress` after each try.
 */
export function camProgram(input: CamInput, progress: (done: number, of: number) => void = () => {}): CamResult & { check: CamCheck } {
  const b = bounds(input.tris);
  // The operator's layout is planned alone; else each side as the height, thinnest first.
  const order = input.orient ? [SIDES.find((s) => s.name === input.orient!.side)!.d.findIndex((v) => v !== 0)] : [0, 1, 2].sort((p, q) => b.max[p] - b.min[p] - (b.max[q] - b.min[q]));
  let best: (CamResult & { check: CamCheck }) | null = null;
  // Right: like the model, nothing hit, and the vise holds the part safely in every setup.
  const good = (r: CamResult & { check: CamCheck }) => r.check.match >= 0.99 && r.check.collisions === 0 && r.check.misplaced === 0 && gougeOf(r.check) < GOUGE_MM3 && r.setups.every((x) => x.physics.ok);
  let bestAxis = order[0];
  const at = (r: CamResult & { check: CamCheck }) => ({ minutes: r.check.minutes, clampings: r.setups.length });
  let bestInput = input;
  // A blank too thin under the part for the 0.5 mm method that way up: that way is not planned (thinBlank); none: refused.
  let thin: Error | null = null;
  const plans = (inp: CamInput) =>
    order.forEach((axis, i) => {
      let r: CamResult;
      try {
        r = planFor(inp, axis);
      } catch (e) {
        if (!/^thinBlank/.test((e as Error).message)) throw e;
        thin ??= e as Error;
        // The live view back where the program made stands (this way was dropped after it began).
        input.live?.({ kind: 'stage', stage: 'post' });
        progress(i + 1, order.length);
        return;
      }
      input.live?.({ kind: 'stage', stage: 'check' });
      const now = checked(inp, r);
      input.live?.({ kind: 'stage', stage: 'post' });
      progress(i + 1, order.length);
      const better = !best || (good(now) && (!good(best) || cheaper(at(now), at(best)))) || (!good(now) && !good(best) && now.check.match > best.check.match);
      if (better) [best, bestAxis, bestInput] = [now, axis, inp];
    });
  plans(input);
  // No side picked and the busiest face first fails the checks: the other face first (the 0.5 mm method holds either way).
  if ((!best || !good(best)) && !input.orient && !input.white) plans({ ...input, simplerFirst: true });
  if (!best && thin) throw thin;
  // None passes with the blank 2 mm over the part (e.g. the outside cut through first leaves the next clamping
  // only a narrow face to hold, where the shop rests the part on a ledge): planned again with it centred.
  if (!good(best!) && !input.margins) plans({ ...input, centred: true });
  // You: a face finished in two clampings shows a step where they meet. Planned again with each such face the last
  // clamping reaches whole left to it (the others keep RESERVE off it); kept when it passes, splits less and takes at
  // most a tenth longer.
  if (good(best!) && best!.pose && !input.reserve) {
    const was = oneClamping(input.tris, best!.code, input.brand, input.speeds, best!.pose, best!.setups.map((x) => x.side));
    if (was.reserve.length) {
      const inp = { ...bestInput, reserve: was.reserve };
      const now = checked(inp, planFor(inp, bestAxis));
      const after = now.pose ? oneClamping(input.tris, now.code, input.brand, input.speeds, now.pose, now.setups.map((x) => x.side)) : null;
      // Never for stock left on a face (a reserved skin no clamping cut): the check's grid is too coarse to see 1 mm.
      if (good(now) && after && after.splitMm2 < was.splitMm2 && after.uncutMm2 <= was.uncutMm2 + 1 && now.check.minutes <= best!.check.minutes * 1.1) [best, bestInput] = [now, inp];
    }
  }
  // The last way (shop rule, rare): the setups no way of holding in the vise passes, in a POM nest.
  // Planned again with them nested; each nest gets its own program (POM, held in the vise).
  const kept = best!;
  const fails = (x: CamResult) => x.setups.filter((st) => !st.physics.ok).map((st) => st.side);
  // Written the shop's way at the end: the same moves in the shop's words (style.ts proves them
  // alike, the check holds), then circles as arcs, checked again in the simulation and taken only
  // when nothing is worse than before.
  const shop = <T extends CamResult & { check: CamCheck }>(r: T): T => {
    // With improvement O1 (approved): a move to where the tool already is is left out.
    const words = shopStyle(r.code, input.brand, (c) => shorten(c, true)).code;
    const arced = arcs(words);
    const was = r.check;
    const c = arced === words ? was : checkProgram(input.tris, arced, input.brand, input.speeds, r.pose, r.corners);
    // Nothing worse: the match (never from a pass to below 0.99), collisions, holders, rapids, grazes, cales, gouges.
    const ok =
      arced !== words &&
      c.match >= was.match - 0.0005 &&
      (was.match < 0.99 || c.match >= 0.99) &&
      c.collisions <= was.collisions &&
      c.holders <= was.holders &&
      c.rapids <= was.rapids &&
      c.grazes.length <= was.grazes.length &&
      c.cales <= was.cales &&
      c.misplaced <= was.misplaced &&
      gougeOf(c) <= gougeOf(was);
    let [code, check] = ok ? [arced, c] : [words, was];
    // Last, on a finer grid than the check's: a rapid down past stock it cannot see feeds the rest of the
    // way (checked again, kept when nothing is worse).
    const finer = finerRapids(code, input.brand, input.speeds);
    if (finer !== code) {
      const f = checkProgram(input.tris, finer, input.brand, input.speeds, r.pose, r.corners);
      if (f.match >= check.match - 0.0005 && f.collisions <= check.collisions && f.rapids <= check.rapids && f.cales <= check.cales && f.misplaced <= check.misplaced && gougeOf(f) <= gougeOf(check)) [code, check] = [finer, f];
    }
    // The program as it goes out, once more on the finer grid: its cuts into the part count as gouges too.
    check = { ...check, pieces: [...check.pieces, ...fineCuts(input.tris, code, input.brand, input.speeds, r.pose)] };
    // A side the designer asked for that got no clamping (nothing left to cut there): said, never silently.
    const made = new Set(r.setups.map((x) => x.side));
    const empty = [...new Set(input.sides ?? [])].filter((x) => SIDES.some((y) => y.name === x) && !made.has(x)).map((side): CamNote => ({ key: 'sideEmpty', side }));
    return { ...r, notes: [...r.notes, ...empty], code: code.replace(`=${TIME}MIN`, `=${(Math.round(check.minutes * 10) / 10).toFixed(1)}MIN`), check };
  };
  if (input.noNest || !fails(kept).length) return shop(kept);
  // Planned again with the failing sides nested, and again with any side that then fails.
  let sides = fails(kept);
  let nested: CamResult & { check: CamCheck } = kept;
  for (let round = 0; round < 3; round++) {
    const r = planFor({ ...bestInput, nestSides: sides }, bestAxis);
    input.live?.({ kind: 'stage', stage: 'check' });
    nested = checked(input, r);
    input.live?.({ kind: 'stage', stage: 'post' });
    const more = fails(nested).filter((x) => !sides.includes(x));
    if (!more.length) break;
    sides = [...sides, ...more];
  }
  if (!good(nested) && !(nested.check.match >= kept.check.match - 0.002 && fails(nested).length < fails(kept).length)) return shop(kept);
  nested.nests = nested.setups
    .filter((x) => x.nest)
    .map((x) => {
      const own = camProgram({ tris: x.nest!.tris, material: 'POM', tools: input.tools, brand: input.brand, limits: input.limits, speeds: input.speeds, name: `${input.name ?? 'TEIL'} NEST`, noNest: true });
      return { side: x.side, nest: x.nest!, code: own.code, check: own.check };
    });
  return shop(nested);
}

/** The program with the part's `vertical` model axis as its height in the first two setups. */
function planFor(input: CamInput, vertical: number): CamResult {
  input.live?.({ kind: 'reset' });
  const limits = input.limits ?? DEFAULT_LIMITS;
  const mat = input.material;
  const missing: Need[] = [];
  const notes: CamNote[] = [];
  // The walls left inside held faces where the jaws or the stop keep the tools off, in their setup's frame.
  const walls: { R: Mat3; t: Vec; z: number; above: number; region: Region }[] = [];
  // The inside corners left at a mill's radius on purpose (CORNER_R), in their setup's frame: no clamping more for them.
  const corners: { R: Mat3; t: Vec; z: number; above: number; region: Region }[] = [];
  const needOnce = (n: Need) => {
    if (!missing.some((m) => m.category === n.category && Math.abs(m.diameter - n.diameter) < 0.01)) missing.push(n);
    else {
      const m = missing.find((x) => x.category === n.category && Math.abs(x.diameter - n.diameter) < 0.01)!;
      m.minLength = Math.max(m.minLength, n.minLength);
    }
  };

  // The model centred on its box.
  const b0 = bounds(input.tris);
  const c0: Vec = [0, 1, 2].map((k) => -(b0.min[k] + b0.max[k]) / 2) as Vec;
  const tris = turnTris(input.tris, IDENTITY, c0);
  const size = [0, 1, 2].map((k) => b0.max[k] - b0.min[k]) as Vec;
  // Raw: the thinnest side gets the thickness allowance, the others the side allowance.
  const order = [0, 1, 2].sort((a, b) => size[a] - size[b]);
  const allow = knowledge.allowance ?? [10, 4, 4];
  // The designer's blank: never any stock on a top plate's white face (it is never faced).
  const white = SIDES.find((x) => x.name === input.white);
  // A side under 0 puts the blank's face inside the part: never planned (the page checks each side too).
  if (input.margins && ![...input.margins.lo, ...input.margins.hi].every((v) => Number.isFinite(v) && v >= 0 && v <= 200)) throw new Error('The blank: stock on each side must be 0 to 200 mm.');
  const margins = input.margins && {
    lo: input.margins.lo.map((v, k) => (white && white.d[k] < 0 ? 0 : v)) as Vec,
    hi: input.margins.hi.map((v, k) => (white && white.d[k] > 0 ? 0 : v)) as Vec,
  };
  const raw: Vec = margins ? (size.map((s, k) => s + margins.lo[k] + margins.hi[k]) as Vec) : (input.raw ?? (size.map((s, k) => s + allow[order.indexOf(k)]) as Vec));
  const rawLo = (margins ? size.map((s, k) => -s / 2 - margins.lo[k]) : raw.map((v) => -v / 2)) as Vec;
  const rawHi = (margins ? size.map((s, k) => s / 2 + margins.hi[k]) : raw.map((v) => v / 2)) as Vec;

  // Sides: the two faces of the chosen height, then whichever reaches most of what is left.
  // The operator's layout: its side first (then the opposite one), both turned as chosen.
  const first = input.orient ? SIDES.findIndex((s) => s.name === input.orient!.side) : -1;
  const thin = first >= 0 ? SIDES[first].d.findIndex((v) => v !== 0) : vertical;
  // The operator's pair of sides turns as chosen; any other side turns a quarter when the jaws would
  // otherwise hold it by its short faces, if it fits one vise turned (the engineers hold the long faces
  // in 21 of 24 clampings: more surface held, sturdier).
  const across = (si: number) => {
    const e = apply(upTurn(SIDES[si].d), size).map(Math.abs);
    return e[0] < e[1] - 0.5 && e[1] <= VISE.width + OVERHANG;
  };
  const spun = (si: number) => (first >= 0 && SIDES[si].d[thin] !== 0 ? !!input.orient?.spin : across(si));
  const feats = SIDES.map((s, si) => sideFeatures(tris, s, spun(si)));
  // The operator's turn of clamping 1 (its side up the one asked, orient), used as given.
  const frame0 = frameAt(input, 0);
  if (frame0 && first >= 0 && apply(frame0, SIDES[first].d)[2] === 1) feats[first] = sideFeatures(tris, SIDES[first], false, frame0);
  input.live?.({ kind: 'stage', stage: 'features' });
  input.live?.({ kind: 'stage', stage: 'stock' });
  // The busiest face first (most floors and holes; you: the 0.5 mm method, after the turn only the face mill).
  const [a, bSide] = [sideOf(thin, 1), sideOf(thin, -1)];
  const busy = (si: number) => feats[si].floors.length + feats[si].holes.length;
  // The operator's pick for setup 2 (any other side than the first), else the first's opposite.
  const second = input.second ? SIDES.findIndex((x) => x.name === input.second) : -1;
  // A top plate's white face up first whatever else (never faced: all the Z stock is on the other side, under the part
  // in clamping 1, where the 0.5 mm method's jaws grip it).
  const whiteUp = [a, bSide].find((si) => SIDES[si].name === input.white);
  const pair = first >= 0 ? [first, second >= 0 && second !== first ? second : first === a ? bSide : a] : whiteUp !== undefined ? [whiteUp, whiteUp === a ? bSide : a] : busy(a) >= busy(bSide) !== !!input.simplerFirst ? [a, bSide] : [bSide, a];
  // The blank 2 mm over the part on the first clamping's side, as the shop faces it (2-3 mm in 64 of 95 first
  // clampings), the rest under the part, where the jaws grip it and the outside goes through (a centred blank
  // left the jaws only the foot of the part's wall).
  // You: the outline is cut whole in the first clamping, so 4 mm under the part where the Z stock allows it (3 gripped,
  // the outline 0.5 under the part and 0.5 over the jaws) and 0.5 to 2 over it; else half of it, 2 at most.
  const top0 = blankTop(raw[thin] - size[thin]);
  if (!margins && !input.centred && SIDES[pair[0]].d[thin] > 0) [rawLo[thin], rawHi[thin]] = [size[thin] / 2 + top0 - raw[thin], size[thin] / 2 + top0];
  else if (!margins && !input.centred) [rawLo[thin], rawHi[thin]] = [-size[thin] / 2 - top0, -size[thin] / 2 - top0 + raw[thin]];
  // A top plate's white face (shop rule): the blank flush with it, so nothing faces it; the stock on the other side.
  if (white && !margins) {
    const k = white.d.findIndex((v) => v !== 0);
    [rawLo[k], rawHi[k]] = white.d[k] > 0 ? [size[k] / 2 - raw[k], size[k] / 2] : [-size[k] / 2, -size[k] / 2 + raw[k]];
  }
  const { occ, reach, cell, grid } = reachable(tris, rawLo, rawHi);
  const covered = new Uint8Array(occ.length);
  const chosen: number[] = [];
  const take = (si: number) => {
    chosen.push(si);
    for (let i = 0; i < occ.length; i++) if (reach[si][i]) covered[i] = 1;
  };
  for (const si of pair) take(si);
  for (const name of input.sides ?? []) {
    const si = SIDES.findIndex((x) => x.name === name);
    if (si >= 0 && !chosen.includes(si)) take(si);
  }
  // Turned over about the machine's X, as the shop mostly does (docs/knowledge: X180 in 63 of 100
  // second clampings, Y180 in 31): the second side is the first one turned 180° about X.
  const [s1, s2] = chosen;
  if (SIDES[s2].d.every((v, k) => v === -SIDES[s1].d[k])) feats[s2] = sideFeatures(tris, SIDES[s2], false, mul([1, 0, 0, 0, -1, 0, 0, 0, -1], feats[s1].R));
  for (;;) {
    let best = -1;
    let gain = 0;
    for (let si = 0; si < 6; si++) {
      if (chosen.includes(si)) continue;
      let g = 0;
      for (let i = 0; i < occ.length; i++) if (reach[si][i] && !covered[i] && !occ[i]) g++;
      if (g > gain) [best, gain] = [si, g];
    }
    if (best < 0 || gain * cell < 2) break;
    take(best);
  }
  let left = 0;
  for (let i = 0; i < occ.length; i++) if (!occ[i] && !covered[i]) left++;
  if (left * cell > 2) notes.push({ key: 'undercut', mm3: Math.round(left * cell) });

  // Holes drilled so far, with how much of their far end is still narrow (0: done).
  const drilled = new Map<string, number>();
  const setups: CamSetup[] = [];
  let prevR: Mat3 | null = null;
  // The shop's template tools for this material, plus the machine's special ones (machine's first).
  const tools = catalog(mat, input.tools, input);
  // Of one Ø, the mills with the shop's roughing data first: the SFH 16 roughs at 2,800 mm/min, the
  // SF 16 has only its finishing data (850) and finishes the walls (docs/knowledge: T4).
  // The tool database's finishing tools likewise (item 14).
  const finishOnly = (t: CamTool) => t.role === 'finish' || (!!t.template && t.template.ops.every((o) => o.kind === 'finish'));
  // Then the machine's own, its roughing mill before its finishing one (HAAS-1: T2 roughs, T21 finishes).
  const role = (t: CamTool) => (t.role === 'rough' || t.category === 'fraise ebauche' ? 0 : t.role === 'finish' || t.category === 'fraise finition' ? 2 : 1);
  const allMills = usable(tools, MILLS).sort((a, b) => b.diameter - a.diameter || Number(finishOnly(a)) - Number(finishOnly(b)) || Number(b.inMachine) - Number(a.inMachine) || role(a) - role(b));
  // Sides planned again turned a quarter (no grip held them as they lay): once each.
  const quartered = new Set<number>();
  // CAM AI's own parallels where the designer's are used instead, by clamping.
  const ownCales = new Map<number, number>();
  // cap: the largest end mill this clamping may use (planned again lighter when the vise cannot hold the bigger ones).
  // rest: resting on the jaw tops by the face this deep under Z0 (planned again so, at grip `fixed`).
  // The designer's choices for clamping 3 and on go with the side they were made for: an asked side with nothing to
  // cut gets no clamping, and its choices never slide onto the next one (a review found that). With sides named
  // (the page names every clamping that carries a choice), a side no one named takes no choice (-1).
  const choiceIndex = (si: number): number => {
    const sidesAsked = input.sides ?? [];
    if (setups.length < 2 || !sidesAsked.length) return setups.length;
    const k = sidesAsked.indexOf(SIDES[si].name);
    return k >= 0 ? k + 2 : -1;
  };
  // Sides turned as the designer asked: once each (a side planned again keeps its turn).
  const turnedAsked = new Set<number>();
  // Sides whose rest on a step did not hold: planned again on their bottom; and those turned a quarter for a step.
  const stepless = new Set<number>();
  const turnedForStep = new Set<number>();
  const addSetup = (si: number, fixed?: number, cap?: number, rest?: number): boolean => {
    // Never a tool the tool database keeps for finishing (item 14): it finishes (below), it does not rough.
    const mills = (cap === undefined ? allMills : allMills.filter((m) => m.diameter <= cap + 1e-6)).filter((m) => m.role !== 'finish');
    // The designer's turn for this clamping, checked as given (flip X or Y, quarter 1 to 3; anything else ignored).
    const turnRaw = prevR && setups.length >= 1 ? input.turns?.[choiceIndex(si)] : undefined;
    const turnAsked = turnRaw && (turnRaw.flip === 'X' || turnRaw.flip === 'Y' || turnRaw.quarter === 1 || turnRaw.quarter === 2 || turnRaw.quarter === 3) ? turnRaw : undefined;
    // A later clamping: of its two frames with the same footprint (as found, and turned 180° about Z),
    // the one the operator reaches from the clamping before with fewer turns. Once: the designer's turn is counted
    // from this frame (the one shown), and a side planned again keeps it.
    // The operator's own turn of this clamping (frames): as given, once, whatever else would turn it.
    const frame = setups.length >= 1 ? frameAt(input, choiceIndex(si)) : undefined;
    const framed = frame && apply(frame, SIDES[si].d)[2] === 1 ? frame : undefined;
    if (framed && !turnedAsked.has(si)) {
      turnedAsked.add(si);
      feats[si] = sideFeatures(tris, SIDES[si], false, framed);
    }
    if (!framed && prevR && setups.length >= 2 && !turnedAsked.has(si)) {
      const turns = (R: Mat3) => {
        const phrase = turnPhrase(mul(R, transpose(prevR!)));
        return phrase ? phrase.match(/DREHEN/g)!.length : R.every((v, k) => Math.abs(v - prevR![k]) < 1e-9) ? 0 : 3;
      };
      const other = mul([-1, 0, 0, 0, -1, 0, 0, 0, 1], feats[si].R);
      if (turns(other) < turns(feats[si].R)) feats[si] = sideFeatures(tris, SIDES[si], false, other);
    }
    if (!framed && turnAsked && prevR && !turnedAsked.has(si)) {
      turnedAsked.add(si);
      let R = feats[si].R;
      // Turned over from the clamping before: about the machine's X, or its Y (the same side up, turned 180° about Z).
      const prevSide = SIDES.findIndex((x) => x.name === setups[setups.length - 1].side);
      if (turnAsked.flip && prevSide >= 0 && SIDES[si].d.every((v, k) => v === -SIDES[prevSide].d[k])) {
        const overX = mul([1, 0, 0, 0, -1, 0, 0, 0, -1], prevR);
        R = turnAsked.flip === 'X' ? overX : mul([-1, 0, 0, 0, -1, 0, 0, 0, 1], overX);
      }
      for (let q = 0; q < (turnAsked.quarter ?? 0); q++) R = mul(SPIN, R);
      feats[si] = sideFeatures(tris, SIDES[si], false, R);
    }
    // What this try changes, to undo when the vise asks for another grip and it is planned again.
    const was = { drilled: new Map(drilled), notes: notes.length };
    input.live?.({ kind: 'stage', stage: 'setup', setup: setups.length, of: Math.max(chosen.length, setups.length + 1), side: SIDES[si].name });
    const side = SIDES[si];
    const f = feats[si];
    const R = f.R;
    const top = f.max[2];
    const t: Vec = [0, 0, -top];
    const P = turnTris(tris, R, t);
    // What is left of the part now, in this setup's frame: the raw box, or what the setups before
    // really left (simulated like the toolpath viewer does).
    const left = setups.length ? remaining(input, setups, size, raw, R, t) : boxLeft(R, t, rawLo, rawHi);
    if (!left) {
      notes.push({ key: 'notSimulated', side: side.name });
      return false;
    }
    const H = f.max[2] - f.min[2];
    // What is left, on the faces it stands for: the part's (in this frame) or the raw block's.
    const rb = boxLeft(R, t, rawLo, rawHi).box;
    // The operator's side stock stands on every wall the clampings cut, the faces across the first
    // clamping's height (the two faces along it are faced to size).
    const v1 = (setups[0]?.R ?? R).slice(6, 9).findIndex((x) => x !== 0);
    const ss = (k: number) => (input.sideStock && R.slice(k * 3, k * 3 + 3).findIndex((x) => x !== 0) !== v1 ? input.sideStock : 0);
    const pb = { lo: [f.min[0] - ss(0), f.min[1] - ss(1), -H - ss(2)] as Vec, hi: [f.max[0] + ss(0), f.max[1] + ss(1), ss(2)] as Vec };
    const sb = { lo: left.box.lo.map((v, k) => onFace(v, true, [pb.lo[k], rb.lo[k]], left.skin, 0)) as Vec, hi: left.box.hi.map((v, k) => onFace(v, false, [pb.hi[k], rb.hi[k]], left.skin, 0)) as Vec };
    const stockH = sb.hi[2] - sb.lo[2];
    // The jaw tops stay 0.5 mm under the top face (Z0): the face mill, wider than the vise, faces down to it (and the
    // 90° graver runs round a chamfered top edge). A part too thin for that with a 3 mm grip is not held
    // safely (faceAtJaws, below). The POM nest's top, with its walls and set screws, stays under it too.
    const most = -0.5 - sb.lo[2];
    // Grip only what is below the part (and as little of it as holds): the outside is cut down to its bottom.
    // In the POM nest the pocket's walls stand where the jaws would: cut down to the nest's top only.
    const nested = !!input.nestSides?.includes(side.name) && stockH >= NEST.minDepth + 1 && most >= NEST.minDepth;
    // Under half the part (turned over, the two halves cut from either side overlap), at most 30 mm:
    // the pocket's walls hold a tall part's foot all round, stiffer than any jaw grip.
    const nestDepth = Math.min(stockH - 1, 30, most, Math.max(NEST.minDepth, Math.floor(stockH / 2) - 1));
    // The first clamping with stock under the part: on 40 mm parallels (5 mm), as the shop holds it (79 of 95
    // first clampings, also where that grips the foot of the part's wall), as long as the outside cuts of both
    // clampings still meet (each 1 mm over its jaws, the next one gripping 3 mm). Else: what is under the part.
    const waste = -H - sb.lo[2];
    // You (the 0.5 mm method, always): clamping 1 cuts the outline 0.5 mm under the part and its jaws grip under that,
    // 3 mm at the least: a blank with less under the part is refused (a thicker one is needed).
    if (!setups.length && !nested && underStock(waste) === 'tooThin') throw new Error(`thinBlank: ${Math.round(waste * 100) / 100} mm under the part, ${GRIP_MIN + 1} needed`);
    // And 0.5 mm over it at the least, to face (you), but on a top plate's white face (never faced).
    if (!setups.length && !nested && side.name !== input.white && sb.hi[2] < TOP_MIN - 1e-6) throw new Error(`thinBlank: ${Math.round(Math.max(0, sb.hi[2]) * 100) / 100} mm over the part, ${TOP_MIN} needed`);
    // A later clamping: as deep as its own cuts beside the held faces allow, as the shop holds it (jaw tops under
    // every such cut in 159 of 160 later clampings, the deepest such grip in 101): 1 mm under the lowest stock
    // still outside the part (what its outside cuts take, slivers under 0.3 mm left out) and under its chamfers
    // near the held faces, 1.3 mm under Z0 (room for the 90° graver at the top edge), and on the faces it holds at 3 mm
    // (1 mm short of where they change).
    // Stock the jaws or the stop would be in the way of: within the smallest mill's radius (and 1 mm) of the held faces
    // (the stock's Y faces) or the stop's (X-). Stock farther in, beside the part but out of the jaws' way (the study's
    // part: slivers in an end pocket 18 mm from the jaws, a strip at its free end), is cut below the jaw tops by a mill
    // small enough, the jaws kept off, and limits no grip.
    const reachR = Math.max(1.5, (mills[mills.length - 1]?.diameter ?? 2) / 2 + 1);
    const nearVise: Region = union([
      ...rect(sb.lo[0] - 60, sb.lo[1] - 60, sb.hi[0] + 60, sb.lo[1] + reachR),
      ...rect(sb.lo[0] - 60, sb.hi[1] - reachR, sb.hi[0] + 60, sb.hi[1] + 60),
      ...rect(sb.lo[0] - 60, sb.lo[1] - 60, sb.lo[0] + reachR, sb.hi[1] + 60),
    ]);
    const deepest = () => {
      let jaw = -1.3;
      // What stands over a level seen from the top: the part's slices above it, every 1 mm, its openings left
      // open (stock under one is reached through it). Stock beside the part but under that is not this
      // clamping's to cut: a later one takes it.
      const shade: { z: number; r: Region }[] = [];
      for (let z = -0.5; z > Math.max(sb.lo[2], -H); z -= 1) shade.push({ z, r: union(shade.at(-1)?.r ?? [], slice(P, z)) });
      const over = (z: number) => shade.filter((s) => s.z > z + 0.5).at(-1)?.r ?? [];
      // From the part's bottom: the stock under it is never cut here, the jaws may grip it (a review finding).
      for (let z = Math.max(sb.lo[2], -H) + 0.05; z < jaw + 1; z += 0.25)
        if (area(intersection(opened(difference(left.at(z - 0.02, z + 0.02), offset(union(filled(slice(P, z)), over(z)), Math.max(0.05, left.skin)))), nearVise)) > 1) {
          jaw = z - 1;
          break;
        }
      const e3 = extent(left.at(sb.lo[2], sb.lo[2] + 3));
      // Its chamfers within a graver's reach (and 1 mm) of the faces it holds, outside or in: the graver's cone
      // stands beside the jaws there (the validation found one 0.95 mm into a jaw, from an inner edge).
      const reach = Math.max(4, ...usable(tools, ['ST']).map((g) => g.diameter / 2)) + 1;
      for (const c of f.chamfers) {
        const lo = c.lo - top;
        if (lo < jaw + 1 && (!e3 || c.min[1] < e3.lo[1] + reach || c.max[1] > e3.hi[1] - reach || c.min[0] < e3.lo[0] + reach)) jaw = Math.min(jaw, lo - 1);
      }
      let same = 3;
      for (const g of CALE_HEIGHTS.map((c) => JAW - c).filter((g) => g > 3).sort((p, q) => p - q)) {
        const e = extent(left.at(sb.lo[2], sb.lo[2] + g + 1));
        // The faces the jaws hold (Y) only: an end along the jaws that changes (a step, stock left there) is not held.
        if (!e3 || !e || Math.abs(e.lo[1] - e3.lo[1]) > 0.2 || Math.abs(e.hi[1] - e3.hi[1]) > 0.2) break;
        same = g;
      }
      return Math.min(jaw - sb.lo[2], same);
    };
    // Clamping 1: the outline cut whole, 0.5 mm under the part (clamp.ts: firstWant).
    const want = !setups.length
      ? firstWant(sb.lo[2], H)
      : nested || fixed !== undefined
        ? 3
        : deepest();
    // Clamping 1 clear of the seam where its outline meets the next clamping's cut (clamp.ts: firstPick, clearOf).
    let pick = nested ? { cale: nestCale(nestDepth), grip: nestDepth } : !setups.length && fixed === undefined ? firstPick(stockH, sb.lo[2], H) : caleFor(stockH, fixed ?? want, fixed ?? 3);
    // The designer's parallels (input.clamps): only those the jaws hold the part on (3 mm or more, never all of it, under its top).
    const cales = allowedCales(stockH, sb.lo[2], !setups.length && !nested ? H : undefined);
    // The faces it could rest on the jaw tops by: never in the first clamping (the raw block has none) or the nest.
    const ledges = setups.length && !nested ? ledgesOf(P, left, sb) : [];
    // The designer's choices for this clamping (choiceIndex).
    const choiceAt = choiceIndex(si);
    const jawAsked = input.jawRests?.[choiceAt] ?? undefined;
    const onJaw = rest ?? (jawAsked !== undefined ? ledges.find((d) => Math.abs(d - jawAsked) < 0.05) : undefined);
    if (rest === undefined && jawAsked !== undefined && onJaw === undefined) notes.push({ key: 'jawRefused', setup: setups.length + 1, cale: jawAsked });
    const asked = onJaw === undefined ? (input.clamps?.[choiceAt] ?? undefined) : undefined;
    // In the POM nest the nest holds it: the parallels asked for do not apply (said, not refused).
    if (nested && asked !== undefined && fixed === undefined) notes.push({ key: 'clampNest', setup: setups.length + 1, cale: asked });
    // Planned again for lighter mills (below), at the designer's grip: still theirs.
    const theirs = !nested && asked !== undefined && cales.includes(asked) && (fixed === undefined || fixed === JAW - asked);
    if (!nested && asked !== undefined && !theirs) notes.push({ key: 'clampRefused', setup: setups.length + 1, cale: asked });
    if (theirs && fixed === undefined && pick.cale !== asked) ownCales.set(setups.length, pick.cale);
    if (theirs) {
      pick = { cale: asked, grip: JAW - asked };
      // The outside of clamping 1 ends within 0.5 mm of the part's bottom: a small step where the next clamping's cut meets it.
      if (!setups.length && waste > 0.5 && !clearOf(sb.lo[2], H, pick.grip)) notes.push({ key: 'clampSeam', setup: 1, cale: asked });
    }
    // On the jaw tops by that face: its body gripped from its bottom up to it, the table 45 mm under it.
    if (onJaw !== undefined) {
      if (jawAsked !== undefined && fixed === undefined) ownCales.set(setups.length, pick.cale);
      pick = { cale: JAW - (-onJaw - sb.lo[2]), grip: -onJaw - sb.lo[2] };
    }
    // You (a picture): on the parallels by a wider step, its narrower body hanging between them ("41 MM UNTERLAGE IN EP
    // 6 MM", the engineers' way), never by that narrow body: at the thickness typed (steps), else the deepest that fits.
    const stepAsked = setups.length && !nested ? (input.steps?.[choiceAt] ?? undefined) : undefined;
    let step: { d: number; cale: number; grip: number } | undefined;
    // The part may be turned a quarter for a step (once, never one the operator turned).
    const mayQuarter = !framed && !turnAsked && !quartered.has(si);
    let quarterForStep = false;
    if (setups.length && !nested && onJaw === undefined && fixed === undefined && !stepless.has(si)) {
      if (stepAsked !== undefined) {
        const d = ledges.find((x) => Math.abs(x - stepAsked) < 0.05);
        const fit = d !== undefined ? stepFit(left, sb, -d) : null;
        if (fit) step = { d: d!, ...fit };
        else if (d !== undefined && mayQuarter && stepFit(left, sb, -d, 0)) quarterForStep = true;
        else notes.push({ key: 'stepRefused', setup: setups.length + 1, cale: stepAsked });
      } else if (!theirs)
        for (const d of [...ledges].sort((p, q) => q - p)) {
          const fit = stepFit(left, sb, -d);
          if (fit) {
            step = { d, ...fit };
            break;
          }
        }
    } else if (stepAsked !== undefined && stepless.has(si)) notes.push({ key: 'stepHold', setup: setups.length + 1, cale: stepAsked });
    // A step the parallels only fit under with the part turned a quarter (its overhang along the jaws): turned so, once,
    // the jaws then on its other pair of faces. Also a side of the operator's pair (you: never on the narrow body; the
    // operator picked which face is up, the turn note says the quarter turn), never one the operator turned by hand.
    if (quarterForStep || (!step && stepAsked === undefined && !theirs && setups.length && !nested && onJaw === undefined && fixed === undefined && !stepless.has(si) && mayQuarter && ledges.some((d) => stepFit(left, sb, -d, 0)))) {
      quartered.add(si);
      turnedForStep.add(si);
      feats[si] = sideFeatures(tris, side, false, mul(SPIN, feats[si].R));
      drilled.clear();
      was.drilled.forEach((v, k) => drilled.set(k, v));
      notes.length = was.notes;
      return addSetup(si, undefined, cap);
    }
    if (step) pick = { cale: step.cale, grip: step.grip };
    // Where the part rests: its bottom, or the step's underside (the body under it hangs between the parallels).
    const base = step ? -step.d : sb.lo[2];
    const stepGap = step ? Math.max(0.6, 2 * left.skin) : 0;
    const { cale, grip } = pick;
    // The 0.5 mm method, whatever chose the grip: clamping 1's jaws 1 mm or more under the part's bottom (its outline).
    if (!setups.length && !nested && sb.lo[2] + grip > -H - 1 + 1e-6) throw new Error(`method: clamping 1's jaws ${Math.round((sb.lo[2] + grip + H) * 100) / 100} mm from the part's bottom`);
    const jawTop = base + grip;
    const floor = base - cale;
    // The vise holds the part by its faces between the parallels and the jaw tops (as contactOf and the
    // app's reader take them): the stop and the fixed jaw touch those, so the shift and the size written
    // come from them, as the shop writes the size after a turn (docs/knowledge/cam-gaps.md, P1). Not from
    // the whole stock: after the first clamping, what stands above the jaws is wider than what they hold.
    // In the POM nest: what sits in its pocket (the pocket is made round it, and the part is put by it).
    const band = extent(left.at(base + stepGap, jawTop - (onJaw !== undefined ? Math.max(0.6, 2 * left.skin) : 0)));
    // The part's own outline over that height, for the faces of the band.
    const nz = Math.max(2, Math.ceil(jawTop - base) + 1);
    const zs = Array.from({ length: nz }, (_, i) => base + stepGap + 0.05 + ((jawTop - base - stepGap - 0.1) * i) / (nz - 1));
    const own = band && left.grow ? extent(zs.reduce((r: Region, z) => union(r, slice(P, Math.min(z, -0.01))), [])) : null;
    const held = band
      ? {
          lo: [0, 1].map((k) => onFace(band.lo[k], true, [(own?.lo[k] ?? NaN) - ss(k), rb.lo[k]], left.skin, left.grow)) as P2,
          hi: [0, 1].map((k) => onFace(band.hi[k], false, [(own?.hi[k] ?? NaN) + ss(k), rb.hi[k]], left.skin, left.grow)) as P2,
        }
      : { lo: [sb.lo[0], sb.lo[1]] as P2, hi: [sb.hi[0], sb.hi[1]] as P2 };
    const hold: [number, number] = [held.hi[0] - held.lo[0], held.hi[1] - held.lo[1]];
    // The designer's spacer at the stop: the part that much off it (only in the vise; the shop's 15 or 50 mm).
    const stopAsked = input.stops?.[choiceAt] ?? undefined;
    // The designer's spacer at the fixed jaw: the part that much toward the operator (only in the vise).
    const ypAsked = input.spacersYp?.[choiceAt] ?? undefined;
    // Part and spacers within the vise's opening (a review: nothing checked it).
    const spacerYp = !nested && ypAsked !== undefined && (SPACERS_Y as readonly number[]).includes(ypAsked) && hold[1] + ypAsked <= VISE.opening ? ypAsked : 0;
    if (ypAsked !== undefined && ypAsked !== 0 && !spacerYp) notes.push({ key: 'spacerRefused', setup: setups.length + 1, cale: ypAsked, side: 'Y+' });
    const spacerX = !nested && (stopAsked === 15 || stopAsked === 50) ? stopAsked : 0;
    // Pushed on every try: a try planned again resets the notes to before it.
    if (stopAsked !== undefined && !spacerX) notes.push({ key: 'stopRefused', setup: setups.length + 1, cale: stopAsked });
    const cx = (held.lo[0] + held.hi[0]) / 2;
    const cy = (held.lo[1] + held.hi[1]) / 2;
    // In the nest the part is the nest's wall off the stop and the fixed jaw, and on its floor.
    const shift: Vec = nested
      ? [STOP_X + NEST.wall + 2 * NEST.clearance + hold[0] / 2 - cx, STOP_Y - NEST.wall - hold[1] / 2 - cy, TABLE_Z - (floor - NEST.floor)]
      : [STOP_X + spacerX + hold[0] / 2 - cx, STOP_Y - spacerYp - hold[1] / 2 - cy, TABLE_Z - floor];
    const turn = prevR ? turnPhrase(mul(R, transpose(prevR))) : '';
    const sizes = `${mm(hold[0])} IN X UND ${mm(hold[1])} IN Y`;
    // "Z+ IN 2MM": the raw top that far above Z0 (what the facing takes off), as the shop writes it.
    const raised = sb.hi[2] > 0.01 ? `/Z+ IN ${mm(sb.hi[2])}MM` : '';
    const setupNotes = nested
      ? [`${prevR ? (turn ? `${turn}/${sizes}` : sizes) : `TEIL MIT ${sizes}`}${raised}`, 'TEIL IN POM-NEST LEGEN / M4 GEWINDESTIFTE X- UND Y- ANZIEHEN', `NEST AUF ${cale} MM UNTERLAGE IM SCHRAUBSTOCK SPANNEN`]
      : [`${prevR ? (turn ? `${turn}/${sizes}` : sizes) : `TEIL MIT ${sizes} EINSPANNEN`}${raised}`, onJaw !== undefined ? `SANS CALE / EPAISSEUR DE ${mm(onJaw)} MM SUR L'ETAU` : step ? `${cale} MM UNTERLAGE IN EP ${mm(step.d)} MM` : cale ? `${cale} MM UNTERLAGE` : 'OHNE UNTERLAGE / TEIL AUF DEM TISCH', ...(spacerX ? [`${spacerX} MM ZWISCHENLAGE IN X-`] : []), ...(spacerYp ? [`${spacerYp} MM ZWISCHENLAGE IN Y+`] : [])];
    // Too long for one vise (with the spacer at the stop): both, as the checker reads it back (setups.ts).
    const twoVises = hold[0] + spacerX > VISE.width + OVERHANG;
    if (!nested && twoVises) setupNotes.push(`MIT 2 SCHRAUBSTOECKEN ${VISE.gap} MM ABSTAND`);
    const ops: CamOp[] = [];
    const clear = Math.max(sb.hi[2], 0) + 2;
    // Below their tops the jaws stand at the held Y faces and the stop at the X- one (kept off from 0.1 mm
    // inside them: the first ring runs 0.02 mm into what it keeps off). Held by a band narrower than what
    // stands above it, the part overhangs them, and a pocket in that overhang reaches over a jaw or the
    // stop. In the nest its walls are cut into. The jaws stand along the vise from the stop, and the
    // second vise's beyond its gap, as the check takes them (viseSpans); kept off 1 mm past their ends, to spare.
    // shortcut: only the end mills keep off them; a drill or graver there is left to the check, which
    // locks the program (none in the reference library); keep those off too if one ever is.
    // The spacer at the stop stands where the stop would (its face kept off like the stop's), the vise that much further left.
    const spans = viseSpans({ jawX: jawsFrom(held.lo[0] - spacerX), twoVises });
    // A spacer in the moving jaw (Y-, "15 MM ZWISCHENLAGE IN Y-") moves that jaw out by its thickness: the spacer
    // is there to be cut into, and the part stays where the program puts it (it rests on the fixed jaw and the stop).
    // The designer's from the start, or none at all; else CAM AI's own where a wall would stay at that jaw (below).
    const yAsked = input.spacersY?.[choiceAt] ?? undefined;
    const yOk = yAsked !== undefined && (SPACERS_Y as readonly number[]).includes(yAsked) && hold[1] + spacerYp + yAsked <= VISE.opening;
    if (yAsked !== undefined && yAsked !== 0 && (nested || !yOk)) notes.push({ key: 'spacerRefused', setup: setups.length + 1, cale: yAsked, side: 'Y-' });
    let spacerY = !nested && yOk ? yAsked! : 0;
    if (spacerY) setupNotes.push(`${spacerY} MM ZWISCHENLAGE IN Y-`);
    // Each jaw 50 mm deep from its face (past any spacer: a review found a 50 mm spacer leaving the moving jaw's band empty).
    const beside = (d: number, end: number): Region =>
      union([
        ...spans.flatMap(([a, b]) => [...rect(a - end, held.lo[1] - spacerY - 50, b + end, held.lo[1] - spacerY + d), ...rect(a - end, held.hi[1] + spacerYp - d, b + end, held.hi[1] + spacerYp + 50)]),
        ...rect(sb.lo[0] - 50, held.lo[1] - 50, held.lo[0] + d, held.hi[1] + 50),
      ]);
    let jaws = nested ? [] : beside(0.1, 1);
    let pastJaws = nested ? [] : beside(-0.05, 0);
    // The 0.1 mm inside the held faces: what opens onto one keeps a wall that thin across it.
    let wallBand = nested ? [] : difference(jaws, beside(0, 1));
    // The moving jaw's held face, for a wall there (the spacer frees it).
    const atMovingJaw = rect(sb.lo[0] - 50, held.lo[1] - 1, sb.hi[0] + 50, held.lo[1] + 0.2);
    // Where the operator leaves 0.1 mm or more on a held face, that wall lies in what is left there: not noted.
    const leftOn = nested
      ? []
      : union([
          ...(ss(1) >= 0.1 ? [...rect(sb.lo[0] - 50, held.lo[1] - 1, sb.hi[0] + 50, held.lo[1] + 0.1), ...rect(sb.lo[0] - 50, held.hi[1] - 0.1, sb.hi[0] + 50, held.hi[1] + 1)] : []),
          ...(ss(0) >= 0.1 ? rect(held.lo[0] - 1, held.lo[1] - 1, held.lo[0] + 0.1, held.hi[1] + 1) : []),
        ]);
    const mine: { z: number; above: number; region: Region }[] = [];
    const myCorners: { z: number; above: number; region: Region }[] = [];

    // 1. Face the top (the face mill, else the largest end mill).
    if (sb.hi[2] > 0.01) {
      const fm = usable(tools, ['MK'])[0] ?? mills[0];
      if (!fm) needOnce({ category: 'tourteau', diameter: 50, minLength: 0, why: { key: 'face' } });
      else ops.push(facing(fm, mat, limits, sb, cy, clear));
    }
    // Its passes at Z0 cover the whole stock: nothing stands above Z0 after it, so the end mills start
    // there (the shop faces first: strategy.faceFirst). From the raw top only if the operator removed it.
    const facedTop = ops.some((o) => o.kind === 'face') && !input.skip?.some((k) => k.startsWith(`${side.name}|PLAN|`));
    const millTop = facedTop ? 0 : sb.hi[2];
    // The plane the tool moves over between cuts, and every drill cycle starts from: 2 mm above the
    // faced top, as the shop's programs (95 % of their links, 3,024 of 3,024 cycle lines), else above the raw top.
    const plane = facedTop ? 2 : clear;

    // 2. Holes from this side: drilled when the inventory has the drill, else milled with the rest.
    const holes = f.holes.map((h) => ({ ...h, top: h.top - top, bottom: h.bottom - top }));
    const keyOf = (h: Hole) => {
      const c = apply(transpose(R), [h.c[0], h.c[1], 0]);
      const axis = apply(transpose(R), [0, 0, 1]).findIndex((v) => v !== 0);
      return `${axis}:${c.map((v, k) => (k === axis ? 0 : Math.round(v * 20))).join(',')}:${Math.round(h.r * 40)}`;
    };
    const drills = usable(tools, ['SB']);
    // The drill of that Ø, else the nearest within 0.12 (as the shop does: Ø2.05 with Ø2, Ø3.2 with Ø3.3),
    // long enough that its holder (Ø50 from the typed length) stays above the stock's top down to zEnd.
    const stockTop = Math.max(sb.hi[2], 0);
    const reachTo = (zEnd: number) => stockTop - zEnd + 2;
    const pinOf = (h: Hole) => (input.partType === 'pinPlate' ? PIN_DRILLS.find(([n]) => Math.abs(h.r * 2 - n) < 0.03)?.[1] : undefined);
    const drillFor = (h: Hole, zEnd: number) => {
      const long = drills.filter((x) => x.length >= reachTo(zEnd));
      const pin = pinOf(h);
      const pinned = pin !== undefined ? long.find((x) => Math.abs(x.diameter - pin) < 0.005) : undefined;
      return pinned ?? long.filter((x) => Math.abs(x.diameter - h.r * 2) <= 0.12).sort((p, q) => Math.abs(p.diameter - h.r * 2) - Math.abs(q.diameter - h.r * 2))[0];
    };
    // done: down to where the hole is finished by the drill. A plain blind hole to the drill's tip (you, Beta 2: the
    // engineers leave the point at a flat bottom, Pb361ad9d, Pfae5765f); else to where its full Ø ends.
    const toDrill: { h: Hole; tool: CamTool; z: number; pin?: boolean; done: number }[] = [];
    // The parallels stand under the held Y faces, 0.3 mm in, as wide as the app's reader puts them
    // (setups.ts placeCales), where the underside lies flat on them; else the reader may move them in.
    const caleW = parallelWidth(hold[1]);
    const strips = [held.lo[1] + 0.3, held.hi[1] - 0.3 - caleW].map((y0) => rect(held.lo[0], y0, held.hi[0], y0 + caleW));
    const flat = strips.every((st) => area(intersection(left.at(base, base + 0.3), st)) >= 0.95 * area(st));
    // A hole clear of both by half a mm: drilled out over the gap between them.
    const betweenCales = (h: Hole) => flat && h.c[1] - h.r - 0.5 > held.lo[1] + 0.3 + caleW && h.c[1] + h.r + 0.5 < held.hi[1] - 0.3 - caleW;
    const keepHoles: Hole[] = [];
    // Holes made from the other side with their counterbore (you): solid here down through their bottom, so no mill
    // goes down one to what lies under it (an end mill of the hole's Ø would drill it, and take the levels under it).
    const otherSide = new Set<Hole>();
    // You: a hole with a bigger one round it (a counterbore) is made in the same clamping as that one. One opening
    // in the opposite face, on its axis, down to where this hole ends: both are made from there, never one from
    // either side after a turn (they would not meet on one axis).
    const opp = feats[SIDES.findIndex((x) => x.d.every((v, k) => v === -side.d[k]))];
    const inModel = (M: Mat3, c: P2) => apply(transpose(M), [c[0], c[1], 0]);
    const axis = apply(transpose(R), [0, 0, 1]).findIndex((v) => v !== 0);
    const counterbored = (h: Hole) => {
      const p = inModel(R, h.c);
      return opp.holes.some((g) => {
        const q = inModel(opp.R, g.c);
        return g.r > h.r + 0.05 && !g.through && g.top - opp.max[2] > -0.1 && Math.abs(h.bottom + H - (g.top - g.bottom)) < 0.1 && [0, 1, 2].every((k) => k === axis || Math.abs(p[k] - q[k]) < 0.05);
      });
    };
    for (const hole of holes) {
      let h = hole;
      const k = keyOf(h);
      if (drilled.get(k) === undefined && counterbored(h)) {
        keepHoles.push(h);
        otherSide.add(h);
        continue;
      }
      // A blind hole CAD draws with a drill point (its middle open under where the wall ends, no smaller hole on
      // from there, and solid 0.75 r off its middle at that height, under a point's cone: not a cross hole or a
      // cavity): drilled to that point, 0.3 x its Ø lower, as the engineers do (the study's E3).
      const pointedAt = (g: Hole) => {
        const under = slice(P, g.bottom - 0.3 * g.r);
        return inside(under, g.c) === 0 && [[1, 0], [0, 1], [-1, 0], [0, -1]].every(([dx, dy]) => inside(under, [g.c[0] + 0.75 * g.r * dx, g.c[1] + 0.75 * g.r * dy]) !== 0);
      };
      // A counterbore's floor: a smaller hole goes on from its bottom (a seat, kept flat).
      const seat = holes.some((o) => o !== h && o.r < h.r && Math.hypot(o.c[0] - h.c[0], o.c[1] - h.c[1]) < 0.05 && Math.abs(o.top - h.bottom) < 0.05);
      let pointed = !h.through && !seat && pointedAt(h);
      // You: no end mill after a drill where the drill could have made the hole. A blind hole whose whole disc stays open
      // in the model under where the reader ended it (a cross hole or a drawn thread splits it; Pf2990f37, P242c06c0,
      // P5295c45b) goes on as one hole: through the part's bottom, drilled through (the through hole's limits over a
      // parallel and the vise floor kept); else to where the model closes, found to 0.02 mm, its point there if drawn.
      if (!h.through && !seat && !pointed && h.bottom > -H + 0.3) {
        const open = (z: number) => {
          const s = slice(P, z);
          return [[0, 0], [0.9, 0], [0, 0.9], [-0.9, 0], [0, -0.9]].every(([dx, dy]) => inside(s, [h.c[0] + dx * h.r, h.c[1] + dy * h.r]) === 0);
        };
        let z = h.bottom - 0.25;
        while (z > -H + 0.05 && open(z)) z -= 0.5;
        if (z <= -H + 0.05) h = { ...h, bottom: -H, through: true };
        else if (z < h.bottom - 0.5) {
          let [lo, hi] = [z, z + 0.5];
          while (hi - lo > 0.02) {
            const m = (lo + hi) / 2;
            if (open(m)) hi = m;
            else lo = m;
          }
          h = { ...h, bottom: hi };
          pointed = pointedAt(h);
          // A drawn point's cone reaches 0.9 r of the middle 0.06 r under where its wall ends (118°): the wall's end.
          if (pointed) h = { ...h, bottom: hi + 0.06 * h.r };
        }
      }
      const depth = h.top - h.bottom + (h.through ? 0.3 * h.r * 2 + 0.5 : pointed ? 0.6 * h.r : 0);
      const lip = drilled.get(k);
      // Drilled already. You: a hole through the part is made in one clamping. The far end one left narrow over a
      // parallel is not drilled from here (it would not meet the hole on one axis): the operator is told (holeShort).
      if (lip !== undefined) {
        keepHoles.push(h);
        continue;
      }
      // Neither a drill of its Ø nor an end mill to mill it (item 15): the nearest smaller drill of the shop, down to
      // 80 % of its Ø, flagged temporary (the right drill stays listed as missing); the hole is that much smaller.
      const millsIt = mills.length > 0 && mills[mills.length - 1].diameter <= h.r * 2 - 0.2;
      // You: a counterbore is made by an end mill after its smaller hole is drilled, never by a drill of its Ø (whose
      // point the mill then had to flatten): left to the milling, no drill listed for it.
      if (seat && millsIt) continue;
      const exact = drillFor(h, h.top - depth);
      const stand = exact || millsIt ? undefined : drills.filter((x) => x.length >= reachTo(h.top - depth) && x.diameter < h.r * 2 && x.diameter >= h.r * 2 * 0.8).sort((p, q) => q.diameter - p.diameter)[0];
      const d = exact ?? stand;
      if (stand) {
        needOnce({ category: 'foret', diameter: Math.round(h.r * 200) / 100, minLength: Math.ceil(reachTo(h.top - depth)), why: { key: 'holeSmaller', d: Math.round(h.r * 200) / 100, depth: Math.round((h.top - h.bottom) * 10) / 10, used: stand.diameter } });
        const note = { key: 'temporaryTool' as const, setup: setups.length + 1, d: Math.round(h.r * 200) / 100, used: stand.diameter };
        if (!notes.some((n) => n.key === note.key && n.setup === note.setup && n.d === note.d)) notes.push(note);
      }
      if (d) {
        // Through the part and past the stock's bottom: between the parallels it comes out at full size; over
        // one its point goes 0.95 mm in (the shop allows 1: CALE_TOUCH); in the nest it stops over the floor.
        // What that leaves narrow at the far end is noted (never drilled from the other side).
        let z = h.through ? h.bottom - (0.3 * d.diameter + 0.5) : pointed ? h.bottom - 0.6 * h.r : h.bottom;
        let rest = 0;
        if (h.through && z < base + 0.1) {
          // You: the shop's full 1 mm into a parallel (0.95: the check's margin); a narrow end under 0.05 mm is nothing.
          // Resting on the jaw tops nothing is under its body: like between the parallels.
          if (nested || (onJaw === undefined && !betweenCales(h)) || z < floor + 1) z = Math.max(z, base + (nested ? 0.1 : -0.95));
          // On the table (no parallels): never into it, 0.5 mm over it.
          if (!cale && !nested) z = Math.max(z, floor + 0.5);
          rest = z + 0.3 * d.diameter - h.bottom;
          rest = rest < 0.05 ? 0 : rest;
        }
        toDrill.push({ h, tool: d, z, pin: pinOf(h) !== undefined && Math.abs(d.diameter - pinOf(h)!) < 0.005, done: !h.through && !seat ? z : z + 0.3 * d.diameter });
        keepHoles.push(h);
        drilled.set(k, rest);
      } else {
        // No drill: milled when an end mill fits (slower); the drill is listed either way.
        const millable = mills.length && mills[mills.length - 1].diameter <= h.r * 2 - 0.2;
        needOnce({ category: 'foret', diameter: Math.round(h.r * 200) / 100, minLength: Math.ceil(reachTo(h.top - depth)), why: { key: millable ? 'holeMilled' : 'hole', d: Math.round(h.r * 200) / 100, depth: Math.round((h.top - h.bottom) * 10) / 10 } });
        if (!millable) {
          keepHoles.push(h);
          drilled.set(k, 0);
        }
      }
    }
    // Where the material over each hole starts when it is drilled: the faced top, or lower where the
    // setups before already took it (sampled every 0.5 mm, from the grid of what they left).
    // Not faced (the operator removed the facing): the raw top (a review finding: R stood on it).
    const faced = facedTop ? Math.min(sb.hi[2], 0) : sb.hi[2];
    const tops = new Map<Hole, number>();
    const surface = (h: Hole) => {
      let s = tops.get(h);
      if (s === undefined) {
        const disc: Region = [circle(h.c, h.r)];
        s = h.top;
        for (let z = faced; z > h.top + 0.05; z -= 0.5) {
          if (area(intersection(left.at(Math.max(z - 0.5, h.top), z), disc)) > 0.01) {
            s = z;
            break;
          }
        }
        tops.set(h, s);
      }
      return s;
    };
    // Between two holes at R (s + margin): clear when no material stands over s along the way, the tool's radius and
    // half a mm round it (the facing takes all over the faced top; jaws and stop stand outside the stock).
    const clearAt = (a: P2, b: P2, s: number, r: number) => {
      if (s >= faced - 1e-6) return true;
      const m = offset(left.at(s + 0.001, faced), r + 0.5);
      const n = Math.max(2, Math.ceil(dist2(a, b) / 0.5));
      for (let i = 0; i <= n; i++) if (inside(m, [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]) !== 0) return false;
      return true;
    };
    // The faced top is where the facing cut; under it, what the earlier clampings left is known to a grid layer.
    const unsure = (s: number) => (s >= faced - 1e-6 ? 0 : left.above);
    if (toDrill.length) ops.push(...drilling(toDrill, usable(tools, ['ZB'])[0] ?? usable(tools, ['AB'])[0], mat, limits, plane, stockTop, surface, input.holes, clearAt, unsure));
    // The holes this clamping's drills make: not one whose drilling the operator removed (its op goes after planning).
    // Such a hole stays solid down through its bottom: no mill is sent under it (nothing drilled to reach it by).
    const drilledHere = toDrill.filter((d) => !input.skip?.some((k) => k.startsWith(`${side.name}|BOHREN_${mm(d.tool.diameter)}MM|${d.tool.code}|`)));
    const undrilled = new Set(toDrill.filter((d) => !drilledHere.includes(d)).map((d) => d.h));

    // 3. Milling level by level: the largest end mill, then smaller ones only where it could not reach.
    const floors = f.floors.map((x) => x.z - top).filter((z) => z < -0.005 && z > -H - 0.01);
    const bottom = -H - 0.5;
    // Also a level at the jaw limit: the outside is cut down to there, never lower.
    const jawLimit = jawTop + 0.5;
    const stops = [...new Set([...floors, bottom, ...(jawLimit < 0 && jawLimit > bottom ? [jawLimit] : [])])].sort((p, q) => q - p);
    const maxAp = mills.length ? cutData(mills[0], 'contour', mat, limits).ap : 2;
    const levels: number[] = [];
    let from = Math.min(0, sb.hi[2]);
    for (const st of stops) {
      if (st > from) continue;
      const n = Math.max(1, Math.ceil((from - st) / maxAp - 1e-6));
      for (let i = 1; i <= n; i++) levels.push(from - ((from - st) * i) / n);
      from = st;
    }
    // What stays at a level: everything of the part above it (sampled every 0.5 mm and at every
    // floor, so a hole running across is not taken for a pocket) and the holes drilled.
    const samples = [...new Set([...Array.from({ length: Math.ceil(H / 0.5) + 1 }, (_, i) => -i * 0.5), ...floors.flatMap((z) => [z + 0.002, z - 0.002])])].filter((z) => z <= 0 && z >= -H).sort((p, q) => q - p);
    let above: Region = [];
    let si2 = 0;
    const keepAt = (z: number): Region => {
      while (si2 < samples.length && samples[si2] > z + 0.001) above = union(above, slice(P, samples[si2++]));
      let k = union(above, slice(P, z + 0.001));
      const disks = keepHoles.filter((h) => h.top > z + 0.001 && (h.bottom < z || undrilled.has(h) || otherSide.has(h))).map((h) => circle(h.c, h.r));
      if (disks.length) k = union(k, disks);
      // The operator's side stock: the walls are left that much out.
      return input.sideStock ? offset(k, input.sideStock) : k;
    };
    const perTool = new Map<CamTool, Work[]>();
    // The mills that took enough of some level to be worth their tool change.
    const worth = new Set<CamTool>();
    // The walls the operator picked to finish: the roughing leaves ALLOW on them for the finishing (that
    // strip counts as done for the smaller tools that follow). Every other wall is roughed to size (0.02 mm
    // in): leaving ALLOW everywhere kept the largest mill out of pockets of its own width, and finishing
    // every wall cost P441ba43c 52 of its 69 minutes. A seal cage's thin walls are finished too, gently (needed:
    // roughed to size at full depth they would bend).
    const precise = !!input.partType && PRECISE.includes(input.partType);
    // Only where it stands as a wall in this clamping (facing sideways): a wall picked in setup 1 is a floor on its side.
    const sideways = (t: Float32Array) => {
      const [u, v] = [[t[3] - t[0], t[4] - t[1], t[5] - t[2]], [t[6] - t[0], t[7] - t[1], t[8] - t[2]]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      return len > 0 && Math.abs(n[2]) / len <= 0.3;
    };
    const picked = (input.finish ?? []).filter((k) => k >= 0 && k * 9 + 8 < P.length).map((k) => P.subarray(k * 9, k * 9 + 9)).filter(sideways);
    // The picked walls between two heights, seen from the top: each triangle's outline (a wall's is a line).
    const wallsAt = (lo: number, hi: number): Ring[] =>
      picked.flatMap((t) =>
        Math.max(t[2], t[5], t[8]) < lo - 0.01 || Math.min(t[2], t[5], t[8]) > hi + 0.01 ? [] : [{ pts: [[t[0], t[1]], [t[3], t[4]], [t[6], t[7]]] as P2[], closed: false, outside: false }],
      );
    // Faces a later clamping finishes whole (oneClamping): kept RESERVE off, walls along their edges, floors over them.
    const reservedTris = (input.reserve ?? [])
      .filter((x) => x.side === side.name)
      .flatMap((x) => x.tris)
      .filter((k) => k >= 0 && k * 9 + 8 < P.length)
      .map((k) => P.subarray(k * 9, k * 9 + 9));
    const reservedAt = (lo: number): Region => {
      const lines: Ring[] = [];
      const floors: Region = [];
      for (const t of reservedTris) {
        const [u, v] = [[t[3] - t[0], t[4] - t[1], t[5] - t[2]], [t[6] - t[0], t[7] - t[1], t[8] - t[2]]];
        const nz = u[0] * v[1] - u[1] * v[0];
        const len = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], nz);
        const zmax = Math.max(t[2], t[5], t[8]);
        const pts = [[t[0], t[1]], [t[3], t[4]], [t[6], t[7]]] as P2[];
        if (len < 1e-9) continue;
        if (Math.abs(nz / len) <= 0.3) {
          // Above the level too, as the part is kept (keepAt): a ring is run down from a higher top when ground is left there.
          if (zmax >= lo - RESERVE) lines.push({ pts, closed: false, outside: false });
        } else if (nz > 0 && lo < zmax + RESERVE) floors.push(pts);
      }
      return union([...(lines.length ? swept(lines, RESERVE) : []), ...(floors.length ? offset(union(floors), RESERVE) : [])]);
    };
    let narrow = 0;
    let narrowDepth = 0;
    let zAbove = Math.max(millTop, 0);
    // Each level's ground and what each end mill took of it. The mills run largest first, each
    // top down: one coming to a level can meet, above it, ground a smaller one takes there later.
    const ground: { z: number; above: number; todo: Region; took: { dia: number; gone: Region }[] }[] = [];
    for (const z of levels) {
      const keep = keepAt(z);
      // All the material between this level and the one above: the side of the tool takes it.
      // Thinner than the simulation's grid next to the part is the grid, not material.
      let todo = difference(left.at(z, zAbove), left.skin ? offset(keep, left.skin) : keep);
      // You (Beta 2): what a drill of this clamping took is done (the grid, left, knows only the clampings before): a
      // ring that would only sweep a drilled hole is not run, down to where the hole is done (toDrill's done): a
      // counterbore's floor and a through hole's narrow end under that are still milled.
      const bored: Region = drilledHere.filter((d) => d.done <= z + 1e-6).map((d) => circle(d.h.c, d.tool.diameter / 2 + 0.15));
      const levelTop = zAbove;
      zAbove = z;
      const inside = z < jawLimit - 0.001;
      // Below the jaw tops: inside the part, and in a later clamping what lies out of the jaws' and the stop's reach.
      if (inside) todo = setups.length ? union(intersection(todo, filled(keep)), difference(todo, nearVise)) : intersection(todo, filled(keep));
      todo = opened(todo);
      // What the tool keeps off: the part, and below the jaw tops the jaws and the stop where the part above reaches over them.
      const over = () => inside && jaws.length > 0 && area(intersection(keep, pastJaws)) > 0.01;
      // A wall the moving jaw would leave across a pocket opening onto the face it holds: a spacer there instead
      // (the shop's, 15 mm), from this level on; it moves nothing, so it needs no other reason (a fixed jaw's or
      // the stop's would shift the part: not used).
      if (!spacerY && yAsked !== 0 && !nested && hold[1] + spacerYp + SPACER_Y <= VISE.opening && over() && area(intersection(intersection(todo, wallBand), atMovingJaw)) > 0.01) {
        spacerY = SPACER_Y;
        jaws = beside(0.1, 1);
        pastJaws = beside(-0.05, 0);
        wallBand = difference(jaws, beside(0, 1));
        setupNotes.push(`${SPACER_Y} MM ZWISCHENLAGE IN Y-`);
      }
      // Below the jaw tops of a later clamping the tools keep off the jaws and the stop wherever they cut (also out of
      // the part's outline, the stock out of their way).
      const off = over() || (inside && setups.length > 0 && jaws.length > 0) ? union(keep, jaws) : keep;
      // Where no tool may go is not left to cut (no smaller end mill would reach it either).
      if (off !== keep) {
        const wall = intersection(todo, wallBand);
        if (area(wall) > 0.01) mine.push({ z, above: levelTop, region: wall });
        todo = opened(difference(todo, jaws));
      }
      // The stock left on the walls to finish here (ALLOW, along them only): not cut now, kept off like the part.
      const walls = wallsAt(z, levelTop);
      const thin = input.partType === 'sealCage' ? thinParts(keep, THIN) : undefined;
      const zone = union([...(walls.length ? swept(walls, ALLOW + 0.5) : []), ...(thin && area(thin) > 0.5 ? offset(thin, ALLOW + 0.5) : [])]);
      const strip = zone.length ? intersection(offset(keep, ALLOW), zone) : [];
      const resv = reservedTris.length ? reservedAt(z) : [];
      const offR = strip.length || resv.length ? union(union(off, strip), resv) : off;
      if (strip.length) todo = opened(difference(todo, strip));
      if (resv.length) todo = opened(difference(todo, resv));
      const level = { z, above: levelTop, todo, took: [] as { dia: number; gone: Region }[] };
      ground.push(level);
      // The largest end mill first. Then, on what it left (corners, narrow pockets), the largest
      // one that takes most of it (80 %): the sizes in between would only add tool changes. A
      // small tool on open ground is the slowest program there is.
      // Long enough from the stock's top, 2 mm to spare for the holder. A machine tool with no length typed
      // (0) never goes down: its holder could not be checked.
      let cands = mills.filter((m) => m.length >= Math.max(0, sb.hi[2]) - z + 2);
      for (let round = 0; round < 6 && cands.length && area(todo) > 0.5; round++) {
        const all = area(todo);
        const attempt = (tool: CamTool) => {
          const cut = cutData(tool, 'pocket', mat, limits);
          // A closed ring under 1 mm round (a hole the tool's size, as milling() simplifies it) has nothing to ramp along:
          // it would go straight down a whole pass. Only where the material takes that (POM; FH, RESOPAL 2 mm): else a
          // smaller mill ramps round it.
          const plunged = plungesInto(tool, mat) && cut.ap <= plungeMm(mat);
          const rings = clearLevel(offR, todo, tool.diameter / 2, cut.ae, inside).filter((g) => plunged || !g.closed || perimeter({ ...g, pts: simplify(g.pts, 0.005, true) }) >= 1);
          if (!rings.length) return null;
          const gone = swept(rings, tool.diameter / 2);
          return { tool, rings, gone, share: area(intersection(todo, gone)) / all };
        };
        let pick: { tool: CamTool; rings: Ring[]; gone: Region; share: number } | null = null;
        if (round === 0) {
          // The first: of the mills that clear about as much as the largest, the one that takes the most a minute,
          // not the largest (the study: the shop's POM Ø30 runs 1000 rpm, F500; its Ø20, which the engineers took, 4000, F1200).
          const rate = (t: CamTool) => {
            const c = cutData(t, 'pocket', mat, limits);
            return c.ap * c.ae * c.f;
          };
          let big: ReturnType<typeof attempt> = null;
          for (const tool of cands) if ((big = attempt(tool))) break;
          // Only a mill of the same kind (type, the shop's template or the machine's own, a roughing one): the shop's
          // own choices stand (the SFH 16 roughs aluminium, HAAS-1's T2 roughs), and a finishing template's data is no rate.
          const like = (t: CamTool) => !!big && t.type === big.tool.type && !!t.template === !!big.tool.template && !!t.inMachine === !!big.tool.inMachine && !finishOnly(t);
          if (big) for (const tool of cands.filter(like).sort((p, q) => rate(q) - rate(p))) {
            if (rate(tool) <= rate(big.tool)) break;
            const a = attempt(tool);
            if (a && a.share >= big.share - 0.05) {
              pick = a;
              break;
            }
          }
          pick ??= big;
        } else
          for (const tool of cands) {
            const a = attempt(tool);
            if (!a) continue;
            if (!pick || a.share > pick.share + 0.02) pick = a;
            if (a.share >= 0.8) break;
          }
        if (!pick) break;
        // Smaller tools only from here on (a bigger one cannot do better on what is left).
        cands = cands.filter((m) => m.diameter < pick!.tool.diameter);
        // A tool not used yet in this setup must take enough to be worth its tool change.
        if (!worth.has(pick.tool) && pick.share * all < 0.5) continue;
        worth.add(pick.tool);
        const r = pick.tool.diameter / 2;
        const pointOf = (g: Ring) => drilledHere.find((x) => x.done > z + 1e-6 && area(difference(swept([g], r), [circle(x.h.c, x.tool.diameter / 2 + 0.15)])) < 0.05);
        const rings = (bored.length ? pick.rings.filter((g) => area(difference(swept([g], r), bored)) > 0.05) : pick.rings)
          // You: no end mill after a drill where nothing of the part is left to cut: a drill's point under the part's
          // bottom (a through hole drilled over a parallel, the stock under the part) is never cleaned.
          .filter((g) => z >= -H - 1e-6 || !pointOf(g))
          .map((g) => {
            // A ring that only cleans a drill's point: its passes start where the drill's full Ø ends (air above).
            const d = pointOf(g);
            return d ? { ...g, from: d.z + 0.3 * d.tool.diameter } : g;
          });
        if (rings.length) (perTool.get(pick.tool) ?? perTool.set(pick.tool, []).get(pick.tool)!).push({ z, above: levelTop, rings, keep: off, inside, thin, finish: area(strip) > 0.01, zone });
        level.took.push({ dia: pick.tool.diameter, gone: pick.gone });
        todo = opened(difference(todo, pick.gone));
        if (pick.tool.diameter / 2 <= CORNER_R + 1e-6) {
          const past = pastCorners(todo, pick.gone, pick.tool.diameter / 2, keep);
          const dropped = difference(todo, past);
          if (area(dropped) > 0.01) myCorners.push({ z, above: levelTop, region: dropped });
          todo = past;
        }
      }
      // What no end mill here could reach: listed once it adds up to more than slivers.
      if (area(todo) > 0.5) {
        narrow += area(todo) * (levelTop - z);
        narrowDepth = Math.max(narrowDepth, -z);
      }
    }
    if (narrow > 5) needOnce({ category: 'fraise', diameter: mills.length ? Math.max(1, Math.floor(mills[mills.length - 1].diameter / 2)) : 6, minLength: Math.ceil(narrowDepth + 2), why: { key: 'narrow', mm3: Math.round(narrow) } });
    // One tool per Ø in a setup: the longest one needed does all the levels of that Ø (one tool
    // change instead of two; the levels stay top down).
    const byDia = new Map<number, CamTool[]>();
    for (const tool of perTool.keys()) (byDia.get(tool.diameter) ?? byDia.set(tool.diameter, []).get(tool.diameter)!).push(tool);
    for (const tool of mills) {
      const same = byDia.get(tool.diameter);
      if (!same?.includes(tool) || same.some((o) => o.length > tool.length)) continue;
      const work = same.flatMap((o) => perTool.get(o)!).sort((p, q) => q.z - p.z);
      // What is still there when this Ø comes: each level's ground less what this Ø and the larger
      // ones took (highest level first). A ring under some of it starts from that level's top.
      const still = ground
        .map((g) => ({ ...g, rest: g.took.filter((t) => t.dia >= tool.diameter).reduce((rest, t) => difference(rest, t.gone), g.todo) }))
        .filter((g) => area(g.rest) > 0.05);
      const r = tool.diameter / 2;
      const upTo = (ring: Ring, z: number) => {
        const sw = swept([ring], r - 0.02);
        return still.find((g) => g.z > z + 1e-6 && area(intersection(sw, g.rest)) > 0.05)?.above ?? null;
      };
      // A ring run from a higher top (upTo) cut its way down there: what it swept is gone at those levels too (the
      // ring as cut, the tool's own sweep, never a wall's allowance), so a smaller mill is not sent up there for it.
      const raised = (ring: Ring, z: number, from: number) => {
        const gone = swept([ring], r - 0.01);
        for (const g of ground) if (g.z > z + 1e-6 && g.above <= from + 1e-6) g.took.push({ dia: tool.diameter, gone });
      };
      const purpose = ops.some((o) => o.kind === 'pocket') ? 'rest' : 'rough';
      // You: the outline first, then the spot drill and the drills, then inside the part (the engineers' order).
      // The first mill's rings outside the part's outline seen from the top, top down, as long as nothing over one
      // is left for later (a ring under ground cut later would take it all at once). Nothing drilled: one operation.
      const drillAt = ops.findIndex((o) => o.kind === 'centre' || o.kind === 'drill');
      const early: Work[] = [];
      const late: Work[] = [];
      if (purpose === 'rough' && drillAt >= 0) {
        while (si2 < samples.length) above = union(above, slice(P, samples[si2++]));
        const outline = filled(above);
        // Nor over a hole to drill here: the spot drill would then meet only air where it expects the stock's top.
        const spots: Region = union(toDrill.map((d) => circle(d.h.c, d.h.r + 0.5)));
        let after: Region = [];
        for (const w of work) {
          const go = w.rings.filter((g) => {
            const sw = swept([g], r);
            return g.pts.every((p) => inside(outline, p) === 0) && area(intersection(sw, after)) < 0.01 && area(intersection(sw, spots)) < 0.01;
          });
          const stay = w.rings.filter((g) => !go.includes(g));
          if (go.length) early.push({ ...w, rings: go });
          if (stay.length) late.push({ ...w, rings: stay });
          if (stay.length) after = union(after, swept(stay, r));
        }
      }
      if (early.length) ops.splice(drillAt, 0, milling(tool, early, mat, limits, millTop, plane, left.at, 'outline', upTo, raised, !input.holes?.legacy));
      if (!early.length || late.length) ops.push(milling(tool, early.length ? late : work, mat, limits, millTop, plane, left.at, purpose, upTo, raised, !input.holes?.legacy));
    }
    // 3b. The walls are finished from the side out of their roughing: one pass (shop rule: more cost
    // too much time); a top plate's or contour insert's pockets only. A seal cage's
    // walls, gently: semi-finish (0.05 left all round), finish, a spring pass (what the tool's bending
    // left). A high-feed mill's walls are finished by the plain mill of its Ø (the shop: SFH 16
    // roughs, SF 16 finishes), the machine's first.
    // Once per Ø (the outline and the inside are two operations of one mill).
    for (const op of ops.filter((o, i) => o.kind === 'pocket' && ops.findIndex((q) => q.kind === 'pocket' && q.tool.diameter === o.tool.diameter) === i)) {
      const roughed = (byDia.get(op.tool.diameter) ?? []).flatMap((o) => perTool.get(o)!).filter((w) => w.finish);
      if (!roughed.length) continue;
      const deepest = Math.min(...roughed.map((w) => w.z));
      // Never a tool the tool database keeps for roughing (item 14); one it gives finishing to first.
      const plain = op.tool.type === 'SFH' ? allMills.filter((m) => m.type === 'SF' && m.role !== 'rough' && Math.abs(m.diameter - op.tool.diameter) < 0.01 && m.length >= Math.max(0, sb.hi[2]) - deepest + 2) : [];
      // Of the shop's templates, the one with its usual finishing data: the SF 16's SCHLICHT at 1,200 mm/min
      // and 10 mm deep (90 % of its SF 16 finishing operations), not the one at 850 and 5.
      const fin = (m: CamTool) => m.template?.ops.filter((o) => o.kind === 'finish').reduce((b, o) => Math.max(b, o.feed * (o.ap ?? 0)), 0) ?? 0;
      const tool = plain.find((m) => m.role === 'finish') ?? plain.find((m) => m.inMachine && m.category === 'fraise finition') ?? plain.find((m) => m.inMachine && m.category !== 'fraise ebauche') ?? [...plain].sort((p, q) => fin(q) - fin(p)).find((m) => fin(m) > 0) ?? op.tool;
      const r = tool.diameter / 2;
      const work: Work[] = [];
      let thinAny = false;
      let lastFin: Ring[] = [];
      for (const w of roughed.sort((p, q) => q.z - p.z)) {
        const near = (g: Ring) => !!w.thin && area(w.thin) > 0.5 && area(intersection(swept([g], r + 0.5), w.thin)) > 0.01;
        const t = w.thin && area(w.thin) > 0.5 ? thickness(w.thin) : 0;
        // Only along the walls to finish (the tool's centre within its radius of them).
        const ring = (d: number) => wallRings(w.keep, w.rings, d, ALLOW, !!w.inside, offset(w.zone ?? [], d + 0.1)).map((g) => (near(g) ? ((thinAny = true), { ...g, thin: t }) : g));
        const fin = ring(r);
        const rings = input.partType !== 'sealCage' ? fin : [...ring(r + 0.05), ...fin, ...fin.map((g) => ({ ...g }))];
        if (!rings.length) continue;
        // A straight wall (the level just above finished by this tool on the very same path): one
        // run from the wall's top in the finish's own depth per pass, no step at each level.
        const prev = work[work.length - 1];
        const [a, b] = [swept(lastFin, r), swept(fin, r)];
        const straight = prev && Math.abs(prev.z - w.above) < 1e-6 && fin.length === lastFin.length && area(difference(a, b)) + area(difference(b, a)) < 0.01;
        work[straight ? work.length - 1 : work.length] = { z: w.z, above: straight ? prev.above : w.above, rings, keep: w.keep, done: w.rings };
        lastFin = fin;
      }
      if (work.length) ops.push(milling(tool, work, mat, limits, millTop, plane, left.at, thinAny ? 'thinWalls' : input.partType === 'sealCage' ? 'finish' : 'contour', undefined, undefined, !input.holes?.legacy));
    }
    // 4. Chamfers on the edges facing up, with the 90° graver.
    // You (Beta 2): a chamfer is cut once. A 45° face is a chamfer from two sides; one a clamping before cut is done.
    const cutBefore = new Set(setups.flatMap((x) => x.chamfered ?? []));
    const fresh = f.chamfers.filter((c) => c.tris.some((k) => !cutBefore.has(k)));
    let chamfered: number[] | undefined;
    if (fresh.length) {
      const graver = usable(tools, ['ST']).find((t) => t.template?.shape === 'G45' || !t.template);
      // Only the chamfers the graver reaches with its holder above the stock's top.
      const reachable = fresh.filter((c) => !graver || graver.length >= stockTop - (c.lo - top - 0.3) + 2);
      const paths = graver ? chamferPaths(P, reachable.map((c) => ({ lo: c.lo - top, hi: c.hi - top })), graver.diameter / 2, jawLimit) : [];
      if (!graver) needOnce({ category: 'chanfrein', diameter: 4, minLength: 25, why: { key: 'chamfer', count: fresh.length } });
      else if (paths.length) {
        ops.push(chamfering(graver, paths, mat, limits, plane));
        chamfered = cutTris(P, reachable.flatMap((c) => c.tris), paths, graver.diameter / 2 + 0.5);
      }
    }
    // 5. A top plate's lettering on this face: the graver along its grooves (engraving()).
    const zones: Zone[] = [];
    if (input.partType === 'topPlate') {
      const grooves = engravings(P, 0, f.floors.map((x) => x.z - top));
      const graver = usable(tools, ['ST']).find((g) => g.template?.shape === 'G45' || !g.template);
      if (grooves.length && graver) {
        const op = engraving(graver, grooves, mat, limits, plane);
        if (op) ops.push(op);
        zones.push({ kind: 'engraving', loops: union(grooves.flatMap((g) => g.region)), lo: -Math.max(...grooves.map((g) => g.depth)), hi: 0 });
      } else if (grooves.length) needOnce({ category: 'chanfrein', diameter: 4, minLength: 25, why: { key: 'chamfer', count: grooves.length } });
    }
    // 6. No deburring pass (the shop's ENTGRATEN round every sharp top edge): you (Beta 2), no chamfer where the model
    // has none.
    // Where precision matters: the contour a top plate or contour insert takes its part in (the
    // pockets' walls, not round holes), a seal cage's thin walls.
    if (precise && (input.partType === 'topPlate' || input.partType === 'contourInsert')) {
      const inner = slice(P, -0.05).filter((l) => {
        const a = -area([l]);
        const perim = l.reduce((t, p, i) => t + Math.hypot(p[0] - l[(i + 1) % l.length][0], p[1] - l[(i + 1) % l.length][1]), 0);
        // A hole (clockwise) that is not round (a circle's 4πA/L² is 1).
        return a > 10 && (4 * Math.PI * a) / (perim * perim) < 0.95;
      });
      if (inner.length) zones.push({ kind: 'contour', loops: inner, lo: -H, hi: 0 });
    }
    if (input.partType === 'sealCage') {
      const thinLevels = [...perTool.values()].flat().filter((w) => w.thin && area(w.thin) > 0.5);
      if (thinLevels.length) zones.push({ kind: 'thinWall', loops: union(thinLevels.flatMap((w) => w.thin!)), lo: Math.min(...thinLevels.map((w) => w.z)), hi: Math.max(...thinLevels.map((w) => w.above)) });
    }
    if (f.freeform > 20) notes.push({ key: 'surface', side: side.name, mm2: Math.round(f.freeform) });

    // Each operation gets its name in the program, then the ones the operator removed go.
    const seen = new Map<string, number>();
    for (const o of ops) {
      const base = `${side.name}|${o.name}|${o.tool.code}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      o.key = `${base}|${n}`;
    }
    if (input.skip?.length) {
      const gone = ops.filter((o) => input.skip!.includes(o.key!));
      // A finishing pass goes with the roughing of its Ø: alone it would plunge into what that roughing leaves.
      const kept = ops.filter((o) => !gone.includes(o) && !(o.kind === 'finish' && gone.some((g) => g.kind === 'pocket' && Math.abs(g.tool.diameter - o.tool.diameter) < 0.01)));
      ops.length = 0;
      ops.push(...kept);
    }

    // Nothing to do from this side after all: no setup.
    if (!ops.length) return false;
    // 5. The vise and the part (physics.ts): held without slipping, tipping, crushing or squeezing
    // it out of size, nothing bending past its limit. A deeper grip first (planned again), then
    // slower cuts.
    // shortcut: the plate checks use the whole part's thickness, not thin pocket floors (part families, step 7).
    const thin = Math.min(stockH, H);
    const squeeze = input.partType === 'topPlate' || input.partType === 'contourInsert' || input.partType === 'sealCage' ? SQUEEZE.precise : SQUEEZE.normal;
    let contact: Contact | null = null;
    const physicsAt = (g: number, jaw = onJaw !== undefined) => {
      const c = contactOf(left, base + stepGap, g - stepGap, twoVises, spacerX, jaw);
      contact = c.contact;
      // How far from the stop each cut works (the parallels' end): past a spacer, that much further.
      const loads = ops.map((op) => loadOf(op, mat, sb.lo[0] - spacerX, c.width || hold[1], limits));
      return checkSetup({ material: mat, length: hold[0], width: c.width || hold[1], height: sb.hi[2] - base, grip: g, thin, contact: c.contact, loads, squeeze });
    };
    const nest = nested ? nestFor(held.lo, held.hi, sb.lo[2], nestDepth) : undefined;
    const physics = nest
      ? checkNest({ material: mat, loads: ops.map((op) => loadOf(op, mat, sb.lo[0], hold[1], limits)), screws: nest.screws.length })
      : physicsAt(grip);
    // On a step that does not hold at full feed: planned again on its bottom (CAM AI's way before).
    if (step && (physics.feed < 1 || !physics.ok)) {
      stepless.add(si);
      // Turned a quarter for the step only: back as it lay.
      if (turnedForStep.has(si)) feats[si] = sideFeatures(tris, side, false, mul(transpose(SPIN), feats[si].R));
      drilled.clear();
      was.drilled.forEach((v, k) => drilled.set(k, v));
      notes.length = was.notes;
      return addSetup(si, undefined, cap);
    }
    if (!nested && fixed === undefined && (physics.feed < 1 || !physics.ok)) {
      // The designer's parallels stay: only lighter mills at their grip.
      // Clamping 1 (the 0.5 mm method): never deeper than 1 mm under the part's bottom, where its outline is cut.
      const grips = theirs || onJaw !== undefined ? [] : CALE_HEIGHTS.map((c) => JAW - c).filter((g) => g >= 3 && g !== grip && g <= stockH - 1 && g <= most && (setups.length > 0 || g <= waste - 1 + 1e-6));
      const deeper = grips.filter((g) => g > grip).sort((p, q) => p - q);
      // A deep band that loses its contact (it reaches material narrower or wider than the faces held): shallower first.
      const lost = physics.issues.some((i) => i.key === 'jawContact' || i.key === 'restContact' || i.key === 'stopContact');
      const other = (lost ? [...grips.filter((g) => g < grip).sort((p, q) => q - p), ...deeper] : deeper).find((g) => {
        const p = physicsAt(g);
        return p.feed >= 1 && !p.issues.some((i) => i.key === 'cannotHold' || i.key === 'jawContact' || i.key === 'restContact' || i.key === 'stopContact');
      });
      if (other !== undefined) {
        drilled.clear();
        was.drilled.forEach((v, k) => drilled.set(k, v));
        notes.length = was.notes;
        return addSetup(si, other, cap);
      }
      // No parallels hold it: resting on the jaw tops by one of its faces, its body gripped below (the shop holds a part
      // that cannot stand on its narrow face so), the one that holds best, the lowest when alike.
      if (onJaw === undefined && !theirs && jawAsked === undefined) {
        const onTop = ledges
          .map((d) => ({ d, p: physicsAt(-d - sb.lo[2], true) }))
          .filter(({ p }) => p.feed >= 1 && !p.issues.some((i) => i.key === 'cannotHold' || i.key === 'jawContact' || i.key === 'restContact' || i.key === 'stopContact'))
          .sort((a, b) => b.p.feed - a.p.feed || b.d - a.d)[0];
        if (onTop) {
          drilled.clear();
          was.drilled.forEach((v, k) => drilled.set(k, v));
          notes.length = was.notes;
          return addSetup(si, -onTop.d - sb.lo[2], cap, onTop.d);
        }
      }
      // No grip holds it as it lies: turned a quarter, the jaws on its other pair of faces (the long faces are
      // preferred, but not over a clamping that holds), once; never against the operator's layout.
      if (!theirs && !turnAsked && !quartered.has(si) && !(first >= 0 && SIDES[si].d[thin] !== 0)) {
        quartered.add(si);
        feats[si] = sideFeatures(tris, side, false, mul(SPIN, feats[si].R));
        drilled.clear();
        was.drilled.forEach((v, k) => drilled.set(k, v));
        notes.length = was.notes;
        return addSetup(si, undefined, cap);
      }
      // Still not at full feed: of the grips the cuts allow (as deep as the stock still to cut beside the part), the one
      // that holds best (the deepest when alike), its contact kept. Where even that one holds the cuts only under half
      // their feed, lighter ones (lighterMill), planned again once at that grip.
      const best = [grip, ...grips]
        .filter((g) => g <= Math.max(grip, want) + 1e-6)
        .map((g) => ({ g, p: physicsAt(g) }))
        .filter(({ p }) => !p.issues.some((i) => i.key === 'jawContact' || i.key === 'restContact' || i.key === 'stopContact'))
        .sort((a, b) => b.p.feed - a.p.feed || b.g - a.g)[0];
      if (best) {
        const width = contactOf(left, sb.lo[2], best.g, twoVises, spacerX, onJaw !== undefined).width || hold[1];
        const loads = ops.map((op) => loadOf(op, mat, sb.lo[0] - spacerX, width, limits).side);
        const worst = ops[loads.indexOf(Math.max(...loads))];
        const d = worst && (worst.kind === 'pocket' || worst.kind === 'finish') ? worst.tool.diameter : 0;
        const lighter = d ? lighterMill(allMills.map((m) => m.diameter), d, best.p.feed) : undefined;
        if (lighter !== undefined || best.g !== grip) {
          drilled.clear();
          was.drilled.forEach((v, k) => drilled.set(k, v));
          notes.length = was.notes;
          return addSetup(si, best.g, lighter ?? cap, onJaw);
        }
      }
    }
    // The contact of the grip used (the retry tried others; a review finding: it kept the last one's).
    if (!nest) physicsAt(grip);
    if (!nest && grip > most + 1e-6) {
      physics.issues.push({ key: 'faceAtJaws' });
      physics.ok = false;
    }
    // No cut within 0.5 mm of the vise floor (the table the parallels, or the part, stand on): the simulation has none.
    const viseFloor = nested ? floor - NEST.floor : floor;
    const done = ops.map((op, i) => slowed(op, physics.opFeed[i])).map((op) => ({ ...op, lines: keepAbove(op.lines, viseFloor + 0.5) }));
    const wallMm3 = mine.reduce((v, w) => v + area(leftOn.length ? difference(w.region, leftOn) : w.region) * (w.above - w.z), 0);
    // shortcut: decided as this clamping is planned; a later one that cuts the wall (holding the part by another
    // face) leaves the note standing. Decide it after the last clamping if one ever does.
    if (wallMm3 > 0.5) notes.push({ key: 'jawWall', side: side.name, mm3: Math.max(1, Math.round(wallMm3)) });
    walls.push(...mine.map((w) => ({ R, t, ...w })));
    corners.push(...myCorners.map((w) => ({ R, t, ...w })));
    const viseIn = nest
      ? { material: mat, length: hold[0], width: hold[1], height: stockH, grip, thin, contact: null, squeeze, left: sb.lo[0], limits, screws: nest.screws.length, floor: viseFloor }
      : { material: mat, length: hold[0], width: contactOf(left, base + stepGap, grip - stepGap, twoVises, spacerX, onJaw !== undefined).width || hold[1], height: sb.hi[2] - base, grip, thin, contact, squeeze, left: sb.lo[0] - spacerX, limits, floor: viseFloor };
    setups.push({ side: side.name, R, t, notes: setupNotes, shift, cale, grip, physics, vise: viseIn, ...(nest ? { nest } : {}), zones, box: [sb.lo[0], sb.lo[1], sb.hi[0], sb.hi[1]], held: [held.lo[0], held.lo[1], held.hi[0], held.hi[1]], contact, ops: done, ...(chamfered && done.some((o) => o.name === 'FASE') ? { chamfered } : {}), cales, ledges, ...(onJaw !== undefined ? { onJaw } : {}), ...(step ? { step: step.d } : {}), steps: setups.length && !nested ? ledges.flatMap((d) => { const fit = stepFit(left, sb, -d); return fit ? [{ depth: d, cale: fit.cale }] : []; }) : [], bottom: sb.lo[2], ...((theirs || (onJaw !== undefined && jawAsked !== undefined)) && ownCales.has(setups.length) ? { own: ownCales.get(setups.length) } : {}) });
    if (input.live) {
      // Back to the model (centred): p = Rᵀ (p' - t).
      const Rt = transpose(R);
      for (const op of done) {
        const seg = opSegments(op.lines);
        const pts: number[] = [];
        for (let i = 0; i < seg.length; i += 3) pts.push(...apply(Rt, [seg[i] - t[0], seg[i + 1] - t[1], seg[i + 2] - t[2]]));
        input.live({ kind: 'path', setup: setups.length - 1, purpose: op.purpose, pts, key: op.key ?? op.name, tool: op.tool.code });
      }
    }
    prevR = R;
    return true;
  };
  for (const si of chosen) addSetup(si);
  // Material still there that should not be (under the jaws, out of a tool's reach): one more
  // setup from the unused side that reaches most of it, simulated again, at most three more.
  // Cells touching the part are left out: the two grids never quite agree there (a skin of
  // cells all round the part, not material left).
  const near = grown(occ, grid.n);
  for (let extra = 0; extra < 3 && setups.length; extra++) {
    const g = simulate(input, setups, size, raw);
    if (!g) break;
    const R1 = setups[0].R;
    const t1 = setups[0].t;
    const gain = SIDES.map(() => 0);
    const { n: rn, origin: ro, step: rs } = grid;
    // Nor the walls the jaws and the stop leave (noted): a clamping more for them costs more than they
    // are; nor the inside corners left at a mill's radius (you: the shop's way). Grown by a cell of either
    // grid, which never quite agree with them.
    const e = Math.max(...g.step, ...rs);
    const thinWalls = [...walls, ...corners].map((w) => ({ ...w, region: offset(w.region, e) }));
    for (let i = 0; i < occ.length; i++) {
      if (near[i]) continue;
      const ix = i % rn[0];
      const iy = Math.floor(i / rn[0]) % rn[1];
      const iz = Math.floor(i / (rn[0] * rn[1]));
      const p0: Vec = [ro[0] + (ix + 0.5) * rs[0], ro[1] + (iy + 0.5) * rs[1], ro[2] + (iz + 0.5) * rs[2]];
      const q = apply(R1, p0);
      const c = [0, 1, 2].map((k) => Math.floor((q[k] + t1[k] - g.origin[k]) / g.step[k]));
      if (c.some((v, k) => v < 0 || v >= g.n[k])) continue;
      if (g.removed[c[2] * g.n[0] * g.n[1] + c[1] * g.n[0] + c[0]] !== KEPT) continue;
      const inWall = thinWalls.some((w) => {
        const p = apply(w.R, p0);
        const z = p[2] + w.t[2];
        return z > w.z - e && z < w.above + e && inside(w.region, [p[0] + w.t[0], p[1] + w.t[1]]) !== 0;
      });
      if (inWall) continue;
      for (let si = 0; si < 6; si++) if (reach[si][i]) gain[si]++;
    }
    const best = gain.map((v, si) => ({ v, si })).filter((x) => !setups.some((st) => st.side === SIDES[x.si].name)).sort((a2, b2) => b2.v - a2.v)[0];
    if (!best || best.v * cell < 5) break;
    if (!addSetup(best.si)) break;
  }

  // The model as planned: centred, turned as setup 1, its top at Z0.
  const pose = setups.length ? { R: setups[0].R, t: [0, 1, 2].map((k) => apply(setups[0].R, c0)[k] + setups[0].t[k]) as Vec } : null;
  // Each corner's clamping frame from setup 1's: p = R1 c + t1 (c the centred model), the corner's q = R c + t.
  const cornersOut: Corner[] = setups.length
    ? corners.map((w) => {
        const M = mul(w.R, transpose(setups[0].R));
        const Mt = apply(M, setups[0].t);
        return { M, b: [0, 1, 2].map((k) => w.t[k] - Mt[k]) as Vec, z: w.z, above: w.above, region: w.region };
      })
    : [];
  const short = [...drilled.values()].filter((rest) => rest > 0).length;
  if (short) notes.push({ key: 'holeShort', count: short });
  return { code: post(input, setups, size, raw), setups, missing, notes, size, raw, pose, blank: { lo: rawLo, hi: rawHi }, short, centred: !!input.centred, corners: cornersOut };
}

/** The coolant word after the tool's first move: the machine's (CamInput.coolant), the same for every tool. */
const COOLANT = { flood: ' M08', air: ' M83', off: '' } as const;

/** The program text, like the shop's. */
/**
 * Text from outside (the model's file name) made safe for a G-code comment: only letters, digits,
 * spaces and `_ . -`. A ')' would end the comment and turn the rest of the name into commands the
 * machine runs but the simulation never sees (for example "#5223=#5223-30", the G54 Z offset).
 */
export function commentSafe(text: string | undefined, fallback = 'TEIL'): string {
  const clean = (text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 _.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

/** Each tool's start (the owner's rule): plane, metric, no radius comp, no cycle, absolute, before anything moves. */
export const SAFE_START = 'G00 G17 G21 G40 G80 G90';

function post(input: CamInput, setups: CamSetup[], size: Vec, raw: Vec): string {
  const s0 = setups[0];
  const fin = apply(s0?.R ?? IDENTITY, size).map(Math.abs);
  const rw = apply(s0?.R ?? IDENTITY, raw).map(Math.abs);
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
  const out: string[] = [
    PROGRAM_MARK,
    `(DATUM DER ERSTELLUNG: ${date} / BEARBEITER: ${commentSafe(input.author, 'CNC')})`,
    `(${commentSafe(input.name)} ${commentSafe(input.material, '')} / ${fin.map(mm).join('X')} / ZUSCHNITT:${rw.map(mm).join('X')})`,
    '(ERSTES TEIL MIT REDUZIERTEM VORSCHUB FAHREN)',
    'G40 G17 G53 G49 G80 G90',
    'G54',
  ];
  for (const s of setups) {
    const first = s === setups[0];
    const clamp = [...s.notes.map((n) => `M0 (${n})`), `G52 X${n3(s.shift[0])} Y${n3(s.shift[1])} Z${n3(s.shift[2])}`];
    // The first clamping: before anything moves. A flip: after the next tool change (it stops the
    // spindle and the coolant, as in the shop's programs), with G53 Y0 bringing the table out.
    // A setup without operations has no tool change to wait for: spindle and coolant off first.
    if (first) out.push(...clamp);
    else if (!s.ops.length) out.push('M05', 'M09', 'G53 Y0', ...clamp);
    s.ops.forEach((op, k) => {
      const t = op.tool;
      // The owner's tool start (unless legacy): every modal state set before the first move, the tool over its first
      // point with the spindle on, then its length and the coolant. Legacy: the length first, as the engineers write it.
      const legacy = !!input.holes?.legacy;
      const at = !legacy && /^G00 G90 X\S+ Y\S+ S\d+ M0?3$/.test(op.lines[0] ?? '') ? 1 : 0;
      const g43 = `G00 G43 H${String(t.number).padStart(2, '0')} Z${SAFE}.${COOLANT[input.coolant ?? 'flood']}`;
      out.push(
        'M09',
        `(TOOLPATH ${op.name})`,
        `T${t.number} M6`,
        `(${toolComment(t)})`,
        `(DIAMETER ${t.diameter.toFixed(2)} MM/LENGTH ${(t.length || 0).toFixed(2)} MM)`,
        ...(!first && k === 0 ? ['G53 Y0', ...clamp] : []),
        'M01 (CHECK TOOL)',
        ...(at ? [SAFE_START, op.lines[0], g43] : legacy ? [g43] : [SAFE_START, g43]),
      );
      // One line at a time: an operation can have hundreds of thousands, too many arguments for one push.
      for (let i = at; i < op.lines.length; i++) out.push(op.lines[i]);
      out.push(`G00 Z${SAFE}.`);
    });
  }
  // The shop's HAAS end: table out, offset cancelled, through-spindle coolant off; the time (set once checked).
  out.push('M09', 'G0 G53 G49 Y0 Z0 M89', `( Gesamt-Bearbeitungszeit =${TIME}MIN )`, 'M30');
  return ['%', `O${String(input.number ?? 1).padStart(4, '0')}`, ...out.map((l, i) => `N${i + 1} ${l}`), '%'].join('\n');
}

/** Every turn the part can lie (for the check). */
export const TURNS = ALL;
