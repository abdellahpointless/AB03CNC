import type { Move, Toolpath, Vec } from './toolpath';

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
  support: number | null;
  supportThickness: number | null;
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
  const grad = t.match(/(\d+)\s*GRAD\s*UM\s*([XYZ])/);
  if (grad) rotation = { axis: grad[2] as 'X', deg: Number(grad[1]) };
  for (const m of t.matchAll(new RegExp(`${NUM}\\s*IN\\s*([XYZ])\\b(?!\\s*UND)`, 'g'))) {
    const v = num(m[1]);
    if ([90, 180, 270].includes(v)) rotation ??= { axis: m[2] as 'X', deg: v };
    else if (m[2] === 'X' && !sizes) onlyX = v;
  }
  if (!sizes && onlyX !== null) sizes = { x: onlyX, y: NaN };
  const sup = t.match(new RegExp(`${NUM}\\s*MM\\s*UNTERLAGE`));
  const thick = t.match(new RegExp(`UNTERLAGE\\s*IN\\s*(?:EP(?:AISSEUR|AISEUR)?\\.?)\\s*${NUM}`));
  const spacer = t.match(new RegExp(`${NUM}\\s*MM\\s*ZWISCHENLAGE\\s*IN\\s*([XYZ]\\s*[+-])`));
  const marker = t.match(/(RAFI|TASTER)\s*(?:IN\s*)?((?:[XYZ]\s*[+-]\s*)+)/);
  const toward = t.match(/Z\+\s*IN\s*([XY]\s*[+-])/);
  const topAt = t.match(new RegExp(`Z\\+\\s*IN\\s*${NUM}\\s*MM`));
  return {
    sizes,
    rotation,
    support: sup ? num(sup[1]) : null,
    supportThickness: thick ? num(thick[1]) : null,
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

export function analyseSetups(tp: Toolpath, opts: SetupOptions): SetupInfo[] {
  const { finished, raw } = partSizes(tp.header);
  const diameter = new Map(tp.tools.map((t) => [t.tool, t.diameter ?? 0]));
  const isFaceMill = (tool: number | null) => {
    const info = tp.tools.find((t) => t.tool === tool);
    return !!info && ((info.diameter ?? 0) >= 25 || /MESSERKOPF|\bMK_|PLAN/i.test(info.label));
  };
  const out: SetupInfo[] = [];

  tp.setups.forEach((s, k) => {
    const notes = s.notes.map((n) => n.text);
    const ins = readInstructions(notes);
    const idx = tp.moves.map((m, i) => (m.setup === k ? i : -1)).filter((i) => i >= 0);
    const moves = idx.map((i) => tp.moves[i]);
    const prev = out[k - 1];
    const info: SetupInfo = {
      index: k,
      line: s.line,
      notes,
      ...ins,
      clamp: ins.clamp ?? (notes.length ? prev?.clamp ?? 'vise' : null),
      stock: null,
      floorZ: null,
      jawTopZ: null,
      jawHalfWidth: 0,
      collisions: [],
      jawClearance: null,
      moves: idx.length ? [idx[0], idx[idx.length - 1]] : null,
    };
    out.push(info);
    if (!notes.length || !moves.length) return;

    // Top of the part: the first facing pass in this setup (plus one step: the raw top is above it).
    const faceLevels = [
      ...new Set(
        moves
          .filter((m) => m.kind === 'feed' && isFaceMill(m.tool) && m.points.length === 2 && Math.abs(m.points[0][2] - m.points[1][2]) < 1e-6)
          .map((m) => Math.round(m.points[0][2] * 1000) / 1000),
      ),
    ].sort((a, b) => b - a);
    const step = faceLevels.length > 1 ? Math.min(3, faceLevels[0] - faceLevels[1]) : 0;
    let topZ = ins.topAt ?? (faceLevels.length ? faceLevels[0] + step : 0);

    // Where the program cuts (finishing tools, not the face mill): the part is around it.
    const pts: Vec[] = [];
    const slack: number[] = [];
    for (const m of moves) {
      if (m.kind === 'rapid' || isFaceMill(m.tool)) continue;
      const add = m.kind === 'drill' ? [m.points[0]] : m.points;
      pts.push(...add);
      // A cutter may run outside the part by its radius (contours, lead-ins).
      for (let n = 0; n < add.length; n++) slack.push((diameter.get(m.tool ?? -1) ?? 0) / 2 + 3);
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const measured = pts.length
      ? { cx: (percentile(xs, 0.05) + percentile(xs, 0.95)) / 2, cy: (percentile(ys, 0.05) + percentile(ys, 0.95)) / 2, w: percentile(xs, 0.95) - percentile(xs, 0.05), h: percentile(ys, 0.95) - percentile(ys, 0.05) }
      : { cx: 0, cy: 0, w: 0, h: 0 };

    // Footprint (X, Y) and height of the part in this setup.
    let sx: number | null = null;
    let sy: number | null = null;
    let height: number | null = null;
    const fits = (t: [number, number, number] | null, a: number, b: number) => {
      if (!t) return null;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) if (i !== j && Math.abs(t[i] - a) < 0.6 && Math.abs(t[j] - b) < 0.6) return t[3 - i - j];
      return null;
    };
    const flipped = ins.rotation?.deg === 180 && ins.rotation.axis !== 'Z' && !!prev?.stock;
    if (ins.sizes && Number.isFinite(ins.sizes.y)) {
      sx = ins.sizes.x;
      sy = ins.sizes.y;
      height = fits(raw, sx, sy) ?? fits(finished, sx, sy) ?? (k === 0 ? raw?.[2] ?? finished?.[2] ?? null : finished?.[2] ?? null);
    } else if (flipped) {
      sx = prev!.stock!.max[0] - prev!.stock!.min[0];
      sy = prev!.stock!.max[1] - prev!.stock!.min[1];
    }
    if (flipped && sx !== null && sy !== null) {
      // Second side: the part is as high as after the first side's facing; Z0 is usually the
      // finished top, so the raw top is what is left to face off.
      height = prev!.stock!.max[2] - prev!.stock!.min[2] - Math.max(0, prev!.stock!.max[2]);
      const finishedHeight = finished ? fits(finished, sx, sy) ?? finished[2] : null;
      if (ins.topAt === null && finishedHeight !== null && height - finishedHeight >= 0 && height - finishedHeight < 20) topZ = height - finishedHeight;
    } else if (sx === null) {
      const dims = k === 0 ? raw ?? finished : finished ?? raw;
      if (dims) {
        let best: { score: number; p: [number, number, number] } | null = null;
        const perms: [number, number, number][] = [
          [dims[0], dims[1], dims[2]], [dims[1], dims[0], dims[2]], [dims[0], dims[2], dims[1]],
          [dims[2], dims[0], dims[1]], [dims[1], dims[2], dims[0]], [dims[2], dims[1], dims[0]],
        ];
        const thinnest = Math.min(...dims);
        for (const p of perms) {
          if (ins.sizes && Math.abs(p[0] - ins.sizes.x) > 0.6) continue;
          // Back side of a plate: it lies flat.
          if (ins.side === 'back' && !ins.onEdge && p[2] !== thinnest) continue;
          // The cuts must fit in the footprint; among those, the closest footprint wins.
          const score = Math.max(0, measured.w - p[0] - 2) * 10 + Math.max(0, measured.h - p[1] - 2) * 10 + Math.abs(p[0] - measured.w) + Math.abs(p[1] - measured.h);
          if (!best || score < best.score) best = { score, p };
        }
        if (best) [sx, sy, height] = best.p;
      }
    }
    if (sx === null || sy === null || height === null || !Number.isFinite(sx) || !Number.isFinite(sy)) return;

    // Where the footprint sits: programs put zero in the middle of the part or on a corner.
    let cx = measured.cx;
    let cy = measured.cy;
    const fin = finished ? (fits(finished, sx, sy) !== null ? [sx, sy] : [Math.min(sx, finished[0]), Math.min(sy, finished[1])]) : [sx, sy];
    const candidates: [number, number][] = [
      [0, 0],
      [fin[0] / 2, -fin[1] / 2],
      [-fin[0] / 2, -fin[1] / 2],
      [fin[0] / 2, fin[1] / 2],
      [-fin[0] / 2, fin[1] / 2],
    ];
    // The zero that keeps the most cuts inside the part wins (ties: the one nearest the cuts).
    let best = { inside: -1, d: Infinity };
    for (const [x, y] of candidates) {
      const inside = pts.length ? pts.filter((p, n) => Math.abs(p[0] - x) <= sx! / 2 + slack[n] && Math.abs(p[1] - y) <= sy! / 2 + slack[n]).length / pts.length : 0;
      const d = Math.hypot(x - measured.cx, y - measured.cy);
      if (inside > best.inside + 0.02 || (Math.abs(inside - best.inside) <= 0.02 && d < best.d)) {
        best = { inside, d };
        if (inside >= 0.6 || d < 4) [cx, cy] = [x, y];
      }
    }
    const min: Vec = [cx - sx / 2, cy - sy / 2, topZ - height];
    const max: Vec = [cx + sx / 2, cy + sy / 2, topZ];
    info.stock = { min, max };
    info.floorZ = min[2] - (ins.support ?? 0);
    if (info.clamp !== 'vise') return;

    // Vise: jaws on the Y faces, from the floor up to the jaw height.
    info.jawTopZ = info.floorZ + opts.jawHeight;
    info.jawHalfWidth = Math.max(62.5, sx / 2 + 15);
    let clearance = Infinity;
    let open: Collision | null = null;
    idx.forEach((mi) => {
      const m = tp.moves[mi];
      const r = (diameter.get(m.tool ?? -1) ?? 0) / 2 || 1;
      let hitHere: Collision | null = null;
      for (const p of samples(m)) {
        const overJaw = (p[1] - r < min[1] || p[1] + r > max[1]) && Math.abs(p[0] - cx) < info.jawHalfWidth + r;
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
  return out;
}
