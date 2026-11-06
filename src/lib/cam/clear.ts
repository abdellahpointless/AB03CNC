import ClipperLib, { type Paths } from 'clipper-lib';
import { area, difference, offset, SCALE, union, type P2, type Region } from './geom';

/*
 * Clearing one Z level of a setup: the tool's centre runs on rings around what must stay (the
 * part, the holes drilled), each ring one step-over further out, until the material is all gone
 * (out past the stock, or the middle of a pocket). Rings are run climbing (part on the tool's
 * right). Each next, smaller tool only runs where the bigger ones could not reach.
 */

/** One ring for the tool centre, and the material it sweeps. */
export interface Ring {
  pts: P2[];
  /** Closed loop (true) or an open piece (where it was trimmed to the material left). */
  closed: boolean;
  /** Around the part's outside (false: inside a pocket). */
  outside: boolean;
}

const toPaths = (r: P2[][]): Paths => r.map((loop) => loop.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const fromPaths = (p: Paths): P2[][] => p.map((loop) => loop.map((q) => [q.X / SCALE, q.Y / SCALE] as P2));
const signedArea = (loop: P2[]) => loop.reduce((t, [x, y], i) => {
  const [x2, y2] = loop[(i + 1) % loop.length];
  return t + x * y2 - x2 * y;
}, 0) / 2;

/** What a tool of radius r sweeps running along rings. */
export function swept(rings: Ring[], r: number): Region {
  if (!rings.length) return [];
  const o = new ClipperLib.ClipperOffset(2, 0.01 * SCALE);
  for (const g of rings) o.AddPaths(toPaths([g.pts]), ClipperLib.JoinType.jtRound, g.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
  const out: Paths = [];
  o.Execute(out, r * SCALE);
  return fromPaths(out);
}

/** Open pieces of the rings that run where there is material (trimmed rings). */
export function trim(loops: P2[][], where: Region): P2[][] {
  const c = new ClipperLib.Clipper();
  // Closed rings given as open lines (repeat the first point) so they come back as pieces.
  c.AddPaths(toPaths(loops.map((l) => [...l, l[0]])), ClipperLib.PolyType.ptSubject, false);
  c.AddPaths(toPaths(where), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctIntersection, tree as unknown as Paths, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromPaths(ClipperLib.Clipper.OpenPathsFromPolyTree(tree));
}

const length = (pts: P2[]) => pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/**
 * The rings of one tool at one level. `keep`: what must not be cut (tool centre stays r away);
 * `left`: the material still to remove here; `stock`: the outline of the raw part (rings stop
 * past it). `insideOnly`: only pockets (below the jaw tops the outside cannot be cut).
 */
export function clearLevel(keep: Region, left: Region, r: number, ae: number, insideOnly: boolean): Ring[] {
  if (area(left) < 0.05) return [];
  // The tool centre may go wherever it sweeps material without touching what stays.
  const reach = offset(left, r - 0.01);
  const rings: Ring[] = [];
  // The first ring 0.02 in: a slot exactly the tool's Ø (a Ø4 slot for a Ø4 end mill, as the shop
  // programs it) still has a path down its middle.
  for (let d = r - 0.02, n = 0; n < 2000; d += ae, n++) {
    const grown = offset(keep, d);
    const loops = grown.filter((l) => l.length > 2);
    if (!loops.length) break;
    // Outer loops (counter-clockwise) go round the outside, the others round pockets.
    let any = false;
    for (const l of loops) {
      const outside = signedArea(l) > 0;
      if (insideOnly && outside) continue;
      // Run climbing: the part on the right.
      const run = [...l].reverse();
      const pieces = trim([run], reach).filter((p) => length(p) > 0.05);
      if (!pieces.length) continue;
      any = true;
      const whole = pieces.length === 1 && Math.abs(length(pieces[0]) - length([...run, run[0]])) < 0.05;
      if (whole) rings.push({ pts: run, closed: true, outside });
      else for (const p of pieces) rings.push({ pts: p, closed: false, outside });
    }
    // Every place the tool centre had to go is inside this ring: done (out past the stock, or
    // the middle of every pocket reached).
    if (!any && area(difference(reach, grown)) < 0.01) break;
  }
  // Outermost (furthest from the part) first: the tool works its way in, never buried.
  return rings.reverse();
}

/** The part's footprint with its pockets filled: inside it, the jaws are never in the way. */
export const filled = (r: Region): Region => union(r.filter((l) => signedArea(l) > 0));
